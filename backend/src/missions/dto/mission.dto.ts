import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { AttachmentDto } from '../../chat/dto/chat.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** `<provider>:<session id>`, as the `session` event returns it. */
const SESSION_REF = /^[a-z0-9-]{1,32}:[A-Za-z0-9_-]{1,128}$/;

export const MISSION_MODES = ['step', 'auto'] as const;
export type MissionMode = (typeof MISSION_MODES)[number];

export const ORCHESTRATOR_MODELS = ['claude:opus', 'claude:sonnet'] as const;

export class CreateMissionDto {
  /** May be empty when the mission only starts from a conversation and its attachments. */
  @Transform(trim)
  @IsString()
  @ValidateIf(
    (dto: CreateMissionDto) => !dto.attachments?.length && !dto.fromSession,
  )
  @MinLength(1)
  @MaxLength(20_000)
  input: string;

  @IsIn(MISSION_MODES)
  mode: MissionMode;

  @IsIn(ORCHESTRATOR_MODELS)
  orchestratorModel: (typeof ORCHESTRATOR_MODELS)[number];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];

  /** Chat conversation the mission starts from. */
  @IsOptional()
  @Matches(SESSION_REF)
  fromSession?: string;
}

export class MissionMessageDto {
  /** May be empty when the message only carries attachments. */
  @Transform(trim)
  @IsString()
  @ValidateIf((dto: MissionMessageDto) => !dto.attachments?.length)
  @MinLength(1)
  @MaxLength(20_000)
  text: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];
}

export class ApproveMissionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  planVersion: number;

  @IsIn(MISSION_MODES)
  mode: MissionMode;
}

export class RedoTaskDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  note: string;
}

export class MissionsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  projectId?: number;
}

export class MissionEventsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  after?: number;
}
