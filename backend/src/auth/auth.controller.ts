import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { CredentialsDto } from './dto/credentials.dto.js';
import { GoogleExchangeDto } from './dto/google-exchange.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { GoogleAuthError, GoogleOAuthService } from './google-oauth.service.js';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';
import { Public } from './public.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly google: GoogleOAuthService,
  ) {}

  @Public()
  @Get('registration')
  async registration() {
    return { open: await this.auth.canRegister() };
  }

  @Public()
  @Post('register')
  register(@Body() dto: CredentialsDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: CredentialsDto) {
    return this.auth.login(dto);
  }

  /** Whether the app has Google credentials: the login page hides the button otherwise. */
  @Public()
  @Get('google/status')
  googleStatus() {
    return { enabled: this.google.isEnabled() };
  }

  @Public()
  @Get('google')
  async googleSignIn(@Res() res: Response): Promise<void> {
    if (!this.google.isEnabled()) {
      throw new NotFoundException('Google sign-in is not configured');
    }
    res.redirect(await this.google.authorizationUrl());
  }

  /** Google sends the browser here: the account is resolved, then the app gets a code. */
  @Public()
  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (error) {
      this.googleFailure(res, error === 'access_denied' ? 'denied' : 'failed');
      return;
    }
    if (!code) {
      this.googleFailure(res, 'failed');
      return;
    }
    try {
      const user = await this.google.complete(code, state);
      const url = new URL(`${this.google.frontendOrigin()}/`);
      // The token stays server-side: the URL carries a one-time code instead.
      url.searchParams.set('code', this.google.issueCode(user.id));
      res.redirect(url.toString());
    } catch (err) {
      this.googleFailure(
        res,
        err instanceof GoogleAuthError ? err.reason : 'failed',
      );
    }
  }

  @Public()
  @Post('google/exchange')
  @HttpCode(HttpStatus.OK)
  async googleExchange(@Body() dto: GoogleExchangeDto) {
    const userId = this.google.consumeCode(dto.code);
    if (userId === null) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    const user = await this.users.findPublicById(userId);
    if (!user) throw new UnauthorizedException('Invalid or expired code');
    return this.auth.signIn(user);
  }

  @Get('me')
  async me(@Req() req: AuthenticatedRequest) {
    const user = await this.users.findPublicById(req.user.sub);
    if (!user) throw new NotFoundException();
    return user;
  }

  @Patch('me')
  update(@Req() req: AuthenticatedRequest, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(req.user.sub, dto);
  }

  @Patch('me/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.auth.changePassword(req.user.sub, dto);
  }

  /** Back to the login page with a reason the app turns into a message. */
  private googleFailure(res: Response, reason: string): void {
    const url = new URL(`${this.google.frontendOrigin()}/`);
    url.searchParams.set('google', 'error');
    url.searchParams.set('reason', reason);
    res.redirect(url.toString());
  }
}
