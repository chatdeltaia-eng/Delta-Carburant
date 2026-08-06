import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service';

type UserRow = { id: string; email: string; display_name: string; password_hash: string; role: string; company_id: string | null; active: boolean };

@Injectable()
export class AuthService {
  constructor(private readonly db: DatabaseService, private readonly jwt: JwtService) {}
  async login(email: string, password: string) {
    const [user] = await this.db.query<UserRow>('SELECT * FROM app_user WHERE email = $1', [email]);
    if (!user?.active || !(await argon2.verify(user.password_hash, password))) throw new UnauthorizedException('Identifiants invalides');
    const payload = { sub: user.id, email: user.email, role: user.role, companyId: user.company_id };
    const accessToken = await this.jwt.signAsync(payload, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' });
    const refreshToken = `${randomUUID()}.${randomUUID()}`;
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    await this.db.query('INSERT INTO refresh_token(user_id, token_hash, expires_at) VALUES ($1,$2,now()+interval \'30 days\')', [user.id, tokenHash]);
    await this.db.query('UPDATE app_user SET last_login_at=now(), failed_login_attempts=0 WHERE id=$1', [user.id]);
    return { accessToken, refreshToken, user: { id: user.id, email: user.email, name: user.display_name, role: user.role } };
  }
  async refresh(token: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [row] = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM refresh_token
       WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()`, [tokenHash]);
    if (!row) throw new UnauthorizedException('Session expirée');
    await this.db.query('UPDATE refresh_token SET revoked_at=now() WHERE token_hash=$1', [tokenHash]);
    const [user] = await this.db.query<UserRow>('SELECT * FROM app_user WHERE id=$1 AND active', [row.user_id]);
    if (!user) throw new UnauthorizedException('Compte indisponible');
    const payload = { sub: user.id, email: user.email, role: user.role, companyId: user.company_id };
    const accessToken = await this.jwt.signAsync(payload, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' });
    const refreshToken = `${randomUUID()}.${randomUUID()}`;
    await this.db.query(`INSERT INTO refresh_token(user_id,token_hash,expires_at)
      VALUES ($1,$2,now()+interval '30 days')`, [user.id, createHash('sha256').update(refreshToken).digest('hex')]);
    return { accessToken, refreshToken };
  }
  async logout(token: string) {
    await this.db.query('UPDATE refresh_token SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL',
      [createHash('sha256').update(token).digest('hex')]);
    return { success: true };
  }
  async me(id: string) {
    const [user] = await this.db.query('SELECT id,email,display_name AS name,role,company_id AS "companyId" FROM app_user WHERE id=$1 AND active', [id]);
    if (!user) throw new UnauthorizedException();
    return user;
  }
}
