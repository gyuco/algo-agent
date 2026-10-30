import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBase64,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export const IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
/** Images, PDFs and plain text (the client sends any text-like file as text/plain). */
export const ATTACHMENT_TYPES = [
  ...IMAGE_TYPES,
  'application/pdf',
  'text/plain',
] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/** 5 MB of file is about 6.7 MB of base64. */
const MAX_ATTACHMENT_BASE64 = 7_000_000;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** `<provider>:<session id>`, as the `session` event returns it. */
const SESSION_REF = /^[a-z0-9-]{1,32}:[A-Za-z0-9_-]{1,128}$/;

export class SessionsQueryDto {
  @Type(() => Number)
  @IsInt()
  projectId: number;
}

export class SessionParamsDto {
  @Matches(SESSION_REF)
  sessionId: string;
}

export class WorkspaceDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  path: string;
}

export class AttachmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @IsIn(ATTACHMENT_TYPES)
  mediaType: AttachmentType;

  @IsBase64()
  @MaxLength(MAX_ATTACHMENT_BASE64)
  data: string;
}

export class ChatMessageDto {
  @IsInt()
  projectId: number;

  /** Catalog agent that answers; omitted, the model answers and may delegate to the project's agents. */
  @IsOptional()
  @Matches(/^[a-z0-9][a-z0-9-]{0,63}$/)
  agent?: string;

  /** May be empty when the turn only carries attachments. */
  @Transform(trim)
  @IsString()
  @ValidateIf((dto: ChatMessageDto) => !dto.attachments?.length)
  @MinLength(1)
  @MaxLength(20_000)
  message: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];

  /** Session to continue, as the `session` event returned it; omitted for a new conversation. */
  @IsOptional()
  @Matches(SESSION_REF)
  sessionId?: string;

  /** `<provider>:<model>`, as listed by /connections; the agent's model when omitted. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9._:/@\-[\]]{1,160}$/i)
  model?: string;

  /** One of the model's `efforts`, as listed by /connections; the model's default when omitted. */
  @IsOptional()
  @Matches(/^[a-z]{1,16}$/)
  effort?: string;

  /** Workflow runs of the conversation since its last turn, whose result the turn passes on to the model. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  workflowRuns?: number[];
}
