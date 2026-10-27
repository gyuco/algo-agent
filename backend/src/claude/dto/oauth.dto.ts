import { Transform } from 'class-transformer';
import {
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CompleteSetupTokenDto {
  @IsUUID()
  sessionId: string;

  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(512)
  @Matches(/^[\x21-\x7e]+$/, { message: 'code must not contain spaces' })
  code: string;
}

export class OAuthTokenDto {
  @Transform(trim)
  @IsString()
  @Matches(/^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/, {
    message: 'token must be a Claude Code OAuth token (sk-ant-oat01-...)',
  })
  token: string;
}
