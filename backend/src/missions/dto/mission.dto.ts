import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
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

export class NewProjectMissionDto extends CreateMissionDto {
  /** The folder name under WORKSPACE_ROOT, and the repository name. */
  @Transform(trim)
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-_.]{0,99}$/)
  name: string;

  @IsIn(['github', 'gitlab'])
  forge: 'github' | 'gitlab';

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  namespace?: string;

  @IsIn(['private', 'internal', 'public'])
  visibility: 'private' | 'internal' | 'public';
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

export class BudgetDto {
  @IsOptional()
  @IsNumber()
  @Min(0.05)
  @Max(0.5)
  fiveHourMinRemaining?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.05)
  @Max(1)
  weeklyMaxShare?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(100_000)
  maxUsd?: number;
}

export class ApproveMissionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  planVersion: number;

  @IsIn(MISSION_MODES)
  mode: MissionMode;

  /** The user's thresholds: they win over the plan's, without changing its version. */
  @IsOptional()
  @ValidateNested()
  @Type(() => BudgetDto)
  budget?: BudgetDto;
}

export class MissionModeDto {
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

  /** Only the missions with an unread notification. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  unread?: boolean;
}

export class MissionEventsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  after?: number;
}
