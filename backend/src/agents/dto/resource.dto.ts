import { IsBoolean } from 'class-validator';

export class ResourceSwitchDto {
  @IsBoolean()
  enabled: boolean;
}
