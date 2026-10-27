import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

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
}

export class BrowseDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1024)
  path?: string;
}
