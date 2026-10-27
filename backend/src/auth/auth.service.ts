import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { PublicUser, UsersService } from '../users/users.service.js';
import { CredentialsDto } from './dto/credentials.dto.js';
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
    return this.issueToken(user);
  }

  async login({ email, password }: CredentialsDto): Promise<AuthResponse> {
    const user = await this.users.findByEmail(email);
    const valid = await bcrypt.compare(
      password,
      user?.passwordHash ?? DUMMY_HASH,
    );
    if (!user || !valid) throw new UnauthorizedException('Invalid credentials');
    return this.issueToken({
      id: user.id,
      email: user.email,
      createdAt: user.createdAt,
    });
  }

  private async issueToken(user: PublicUser): Promise<AuthResponse> {
    const payload: JwtPayload = { sub: user.id, email: user.email };
    return { accessToken: await this.jwt.signAsync(payload), user };
  }
}
