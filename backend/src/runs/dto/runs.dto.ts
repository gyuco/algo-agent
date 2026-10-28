import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class FollowQueryDto {
  /** Last `seq` the client has; omitted, the stream starts from the first event. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  after?: number;
}
