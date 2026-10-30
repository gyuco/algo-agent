import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { PublicUser, UsersService } from '../users/users.service.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { CredentialsDto } from './dto/credentials.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { JwtPayload } from './jwt-auth.guard.js';

const BCRYPT_ROUNDS = 12;
// Compared against when the email is unknown, so timing doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('dummy-password', BCRYPT_ROUNDS);

export interface AuthResponse {
  accessToken: string;
  user: PublicUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canRegister(): Promise<boolean> {
    if (this.config.get('ALLOW_REGISTRATION') === 'true') return true;
    return (await this.users.count()) === 0;
  }

  async register({ email, password }: CredentialsDto): Promise<AuthResponse> {
    if (!(await this.canRegister())) {
      throw new ForbiddenException('Registration is disabled');
    }
    if (await this.users.findByEmail(email)) {
      throw new ConflictException('Email already registered');
    }
    const user = await this.users.create(
      email,
      await bcrypt.hash(password, BCRYPT_ROUNDS),
    );
    return this.signIn(user);
  }

  async login({ email, password }: CredentialsDto): Promise<AuthResponse> {
    const user = await this.users.findByEmail(email);
    const valid = await bcrypt.compare(
      password,
      user?.passwordHash ?? DUMMY_HASH,
    );
    if (!user || !valid) throw new UnauthorizedException('Invalid credentials');
    return this.signIn({
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    });
  }

  /** Changes the editable account fields and reissues the token with the new email. */
  async updateProfile(
    userId: number,
    { email, name }: UpdateProfileDto,
  ): Promise<AuthResponse> {
    if (email) {
      const owner = await this.users.findByEmail(email);
      if (owner && owner.id !== userId) {
        throw new ConflictException('Email already registered');
      }
    }
    const user = await this.users.updateProfile(userId, {
      ...(email !== undefined && { email }),
      ...(name !== undefined && { name: name.length > 0 ? name : null }),
    });
    return this.signIn(user);
  }

  async changePassword(
    userId: number,
    { currentPassword, newPassword }: ChangePasswordDto,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException();
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException(
        'The new password must be different from the current one',
      );
    }
    await this.users.updatePassword(
      userId,
      await bcrypt.hash(newPassword, BCRYPT_ROUNDS),
    );
  }

  /** Issues the token for an already authenticated user: password or Google. */
  async signIn(user: PublicUser): Promise<AuthResponse> {
    const payload: JwtPayload = { sub: user.id, email: user.email };
    return { accessToken: await this.jwt.signAsync(payload), user };
  }
}
