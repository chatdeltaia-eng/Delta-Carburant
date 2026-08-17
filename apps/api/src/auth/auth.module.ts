import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { LoginAlertService } from './login-alert.service';
import { MailingModule } from '../mailing/mailing.module';
@Module({ imports: [PassportModule, JwtModule.register({}), MailingModule], controllers: [AuthController], providers: [AuthService, JwtStrategy, LoginAlertService], exports: [JwtStrategy] })
export class AuthModule {}
