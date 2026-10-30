import { IsString, MinLength } from 'class-validator';

/** The one-time code the callback put in the URL: redeemed right away for a token. */
export class GoogleExchangeDto {
  @IsString()
  @MinLength(16)
  code: string;
}
