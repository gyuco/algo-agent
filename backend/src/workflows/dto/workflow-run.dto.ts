import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class WorkflowRunDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  input: string;
}
