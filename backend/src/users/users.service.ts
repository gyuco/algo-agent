import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface PublicUser {
  id: number;
  email: string;
  name: string | null;
  createdAt: Date;
}

/** The fields every response exposes: never the password hash. */
const PUBLIC_SELECT = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: number) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findPublicById(id: number): Promise<PublicUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: PUBLIC_SELECT,
    });
  }

  count() {
    return this.prisma.user.count();
  }

  create(email: string, passwordHash: string): Promise<PublicUser> {
    return this.prisma.user.create({
      data: { email, passwordHash },
      select: PUBLIC_SELECT,
    });
  }

  updateProfile(
    id: number,
    data: { email?: string; name?: string | null },
  ): Promise<PublicUser> {
    return this.prisma.user.update({
      where: { id },
      data,
      select: PUBLIC_SELECT,
    });
  }

  async updatePassword(id: number, passwordHash: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash },
      select: { id: true },
    });
  }
}
