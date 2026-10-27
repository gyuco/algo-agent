import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConnectionsService } from '../connections/connections.service.js';
import { formatRef } from './model-ref.js';
import type {
  AgentProvider,
  ConnectionStatus,
  ProviderStatus,
} from './provider.js';

/** Injection token for the list of providers, in the order they are offered. */
export const AGENT_PROVIDERS = Symbol('AGENT_PROVIDERS');

/** The API view of a provider's status: model values become refs the chat can send back. */
export function toConnectionStatus(
  provider: AgentProvider,
  status: ProviderStatus,
): ConnectionStatus {
  return {
    provider: provider.id,
    label: provider.label,
    ...status,
    models: status.models.map((m) => ({
      ...m,
      value: formatRef(provider.id, m.value),
    })),
  };
}

@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);

  constructor(
    @Inject(AGENT_PROVIDERS) private readonly providers: AgentProvider[],
    private readonly connections: ConnectionsService,
  ) {}

  ids() {
    return this.providers.map((p) => p.id);
  }

  get(id: string): AgentProvider {
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) throw new NotFoundException(`Provider ${id} sconosciuto`);
    return provider;
  }

  async status(userId: number, id: string): Promise<ConnectionStatus> {
    const provider = this.get(id);
    try {
      return toConnectionStatus(provider, await provider.status(userId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${id} status failed: ${message}`);
      return toConnectionStatus(provider, {
        methods: [],
        connected: false,
        method: null,
        secretHint: null,
        connectedAt: null,
        version: null,
        models: [],
        error: message,
      });
    }
  }

  statuses(userId: number): Promise<ConnectionStatus[]> {
    return Promise.all(this.providers.map((p) => this.status(userId, p.id)));
  }

  disconnect(userId: number, id: string) {
    return this.get(id).disconnect(userId);
  }

  /** The provider used when neither the chat nor the agent names a model: the first one connected. */
  async defaultFor(userId: number): Promise<AgentProvider> {
    const connected = await this.connections.connected(userId);
    const provider = this.providers.find((p) => connected.includes(p.id));
    if (!provider) {
      throw new BadRequestException(
        'Nessun provider connesso: collegane uno in Connessioni',
      );
    }
    return provider;
  }
}
