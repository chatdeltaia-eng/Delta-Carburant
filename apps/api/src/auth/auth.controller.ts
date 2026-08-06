import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
class LoginDto { @IsEmail() email!: string; @IsString() @MinLength(8) password!: string; }
class TokenDto { @IsString() @MinLength(20) refreshToken!: string; }
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('login') login(@Body() dto: LoginDto) { return this.auth.login(dto.email, dto.password); }
  @Post('refresh') refresh(@Body() dto: TokenDto) { return this.auth.refresh(dto.refreshToken); }
  @Post('logout') logout(@Body() dto: TokenDto) { return this.auth.logout(dto.refreshToken); }
  @UseGuards(AuthGuard('jwt')) @Get('me') me(@Req() req: { user: { sub: string } }) { return this.auth.me(req.user.sub); }
}
