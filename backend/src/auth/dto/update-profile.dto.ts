import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email?: string;

  /** Empty string clears the display name, falling back to the email local part. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(80)
  name?: string;
}
