import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** An empty field clears the value instead of storing an empty string. */
const trimOrNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text === '' ? null : text;
};

/** A data URL of an image, or a remote one. */
const LOGO = /^(data:image\/[a-z0-9.+-]+;base64,|https?:\/\/)/i;

export class ProjectDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  path: string;

  /** "#rrggbb", the icon's colour when the project has no logo. */
  @IsOptional()
  @Transform(trimOrNull)
  @Matches(/^#[0-9a-f]{6}$/i, { message: 'Colore non valido' })
  color?: string | null;

  /** Data URL of an uploaded image, or an http(s) one; drawn in place of the initial. */
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(4_000_000)
  @Matches(LOGO, { message: 'Logo non valido' })
  logo?: string | null;
}

export class BrowseDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1024)
  path?: string;
}
