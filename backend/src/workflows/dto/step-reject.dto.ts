import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

export class StepRejectDto {
  /** Why, for the run's history. */
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string;
}
