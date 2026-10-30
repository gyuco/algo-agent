import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @MaxLength(72)
  currentPassword: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72) // bcrypt ignores bytes beyond 72
  newPassword: string;
}
