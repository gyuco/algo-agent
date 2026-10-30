import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { CredentialsDto } from './dto/credentials.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
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
}
