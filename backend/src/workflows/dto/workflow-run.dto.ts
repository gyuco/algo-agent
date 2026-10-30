import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Who fills one of the workflow's agents for this run: the slot is the agent the workflow names. */
export class WorkflowAssignDto {
  @Matches(KEY)
  slot: string;

  @Matches(KEY)
  agent: string;

  /** `<provider>:<model>`, as listed by /connections; the agent's model when omitted. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9._:/@\-[\]]{1,160}$/i)
  model?: string;

  /** One of the model's `efforts`; the model's default when omitted. */
  @IsOptional()
  @Matches(/^[a-z]{1,16}$/)
  effort?: string;
}

export class WorkflowRunDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  input: string;

  /** Chat conversation the run belongs to; omitted in a new conversation. */
  @IsOptional()
  @Matches(/^[a-z0-9-]{1,32}:[A-Za-z0-9_-]{1,128}$/)
  sessionId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => WorkflowAssignDto)
  assign?: WorkflowAssignDto[];
}
