import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

export class ApiKeyDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^sk-ant-[A-Za-z0-9_-]{20,}$/, {
    message: 'apiKey must be an Anthropic API key (sk-ant-...)',
  })
  apiKey: string;
}
