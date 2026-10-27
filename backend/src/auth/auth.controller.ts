import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { CredentialsDto } from './dto/credentials.dto.js';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';
import { Public } from './public.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
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

  @Get('me')
  async me(@Req() req: AuthenticatedRequest) {
    const user = await this.users.findPublicById(req.user.sub);
    if (!user) throw new NotFoundException();
    return user;
  }
}
