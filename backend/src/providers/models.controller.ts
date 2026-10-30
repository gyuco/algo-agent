import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { EnabledModelsService } from './enabled-models.service.js';
import { ProvidersService } from './providers.service.js';

/** Body of a model switch: the model reference and whether it is on. */
interface ModelToggleBody {
  value?: unknown;
  enabled?: unknown;
}

/**
 * The models of every connected provider, each with its switch. The chat only
 * offers the switched-on ones; with none on it offers them all.
 */
@Controller('resources/models')
export class ModelsController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly enabled: EnabledModelsService,
  ) {}

  @Get()
  async list(@Req() req: AuthenticatedRequest) {
    const [statuses, enabled] = await Promise.all([
      this.providers.statuses(req.user.sub),
      this.enabled.list(req.user.sub),
    ]);
    const on = new Set(enabled);
    const models = statuses.flatMap((status) =>
      status.models.map((model) => ({
        ...model,
        provider: status.provider,
        providerLabel: status.label,
        enabled: on.has(model.value),
      })),
    );
    // An enabled model that no longer exists doesn't restrict the chat.
    return { models, restricted: models.some((model) => model.enabled) };
  }

  @Get('enabled')
  async selection(@Req() req: AuthenticatedRequest) {
    const values = await this.enabled.list(req.user.sub);
    return { values, restricted: values.length > 0 };
  }

  @Put()
  @HttpCode(HttpStatus.NO_CONTENT)
  async set(@Req() req: AuthenticatedRequest, @Body() body: ModelToggleBody) {
    if (typeof body.value !== 'string' || body.value.trim() === '') {
      throw new BadRequestException('Modello non valido');
    }
    if (typeof body.enabled !== 'boolean') {
      throw new BadRequestException('enabled deve essere un booleano');
    }
    await this.enabled.set(req.user.sub, body.value, body.enabled);
  }
}
