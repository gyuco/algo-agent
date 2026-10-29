import { Injectable } from '@nestjs/common';
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Mission } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MissionEventBus } from './mission-event-bus.js';
import {
  canonicalJson,
  planSchema,
  type Plan,
} from './plan-schema.js';
import type { PlanValidationResult } from './plan-validation.js';

export interface MissionToolScope {
  mission: Mission;
  runId: number;
  validate: (plan: Plan) => Promise<PlanValidationResult>;
  /** Tells the runtime that no other tool may run in this turn. */
  closeTurn: () => void;
  /** Claims the end of the turn for this call; false when another call already did. */
  beginClose: () => boolean;
  /** Releases the claim when the plan is invalid and the turn can go on. */
  cancelClose: () => void;
}

const text = (value: string) => ({
  content: [{ type: 'text' as const, text: value }],
});
const failure = (value: string) => ({
  content: [{ type: 'text' as const, text: value }],
  isError: true,
});

/**
 * The orchestrator's tools, kept out of APP_TOOLS: they exist only inside a
 * briefing and must not appear among the project's switchable resources.
 */
@Injectable()
export class MissionTools {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: MissionEventBus,
  ) {}

  forRun(scope: MissionToolScope): SdkMcpToolDefinition<any>[] {
    return [this.askUser(scope), this.proposePlan(scope)];
  }

  private askUser(scope: MissionToolScope) {
    return tool(
      'ask_user',
      'Ask the user one question in the briefing, optionally with answers to choose from. The turn ends after it.',
      {
        question: z.string().trim().min(1).max(4_000),
        options: z.array(z.string().trim().min(1).max(200)).max(6).optional(),
      },
      async ({ question, options }) => {
        if (!scope.beginClose()) {
          return failure('Il turno è già chiuso: non fare altre domande.');
        }
        const data = { question, ...(options?.length ? { options } : {}) };
        const entry = await this.prisma.$transaction(async (tx) => {
          const entry = await tx.missionEntry.create({
            data: {
              missionId: scope.mission.id,
              kind: 'question',
              dataJson: JSON.stringify(data),
            },
          });
          const { count } = await tx.mission.updateMany({
            where: { id: scope.mission.id, status: 'briefing' },
            data: {
              waitJson: JSON.stringify({
                code: 'question',
                entryId: entry.id,
              }),
            },
          });
          if (!count) throw new Error('not-briefing');
          return entry;
        }).catch((error: unknown) => {
          if (error instanceof Error && error.message === 'not-briefing') {
            return null;
          }
          throw error;
        });
        if (!entry) {
          return failure('La missione non è più nel briefing: la domanda non è stata registrata.');
        }
        this.bus.publish(entry);
        scope.closeTurn();
        return text(
          'Domanda registrata. Turno chiuso: termina ora senza altro testo.',
        );
      },
      { annotations: { readOnlyHint: false } },
    );
  }

  private proposePlan(scope: MissionToolScope) {
    return tool(
      'propose_plan',
      'Propose the complete mission plan. Validation errors come back to you: fix them and call it again.',
      { plan: planSchema },
      async ({ plan }) => {
        if (!scope.beginClose()) {
          return failure('Il turno è già chiuso: non proporre un altro piano.');
        }
        const parsed = planSchema.safeParse(plan);
        if (!parsed.success) {
          scope.cancelClose();
          return text(`Piano non valido:\n${z.prettifyError(parsed.error)}`);
        }
        let validation: PlanValidationResult;
        try {
          validation = await scope.validate(parsed.data);
        } catch (error) {
          scope.cancelClose();
          return failure(
            `Validazione non riuscita: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (validation.errors.length) {
          scope.cancelClose();
          return text(
            `Piano non valido: correggi e riprova.\n- ${validation.errors.join('\n- ')}`,
          );
        }

        const canonical = canonicalJson(parsed.data);
        const current = await this.prisma.mission.findUnique({
          where: { id: scope.mission.id },
          select: { planJson: true, planVersion: true, status: true },
        });
        if (!current || current.status !== 'briefing') {
          return failure('La missione non è più nel briefing: il piano non è stato salvato.');
        }
        if (current.planJson === canonical) {
          const { count } = await this.prisma.mission.updateMany({
            where: { id: scope.mission.id, status: 'briefing' },
            data: { status: 'planned', waitJson: null },
          });
          if (count) {
            const entry = await this.prisma.missionEntry.create({
              data: {
                missionId: scope.mission.id,
                kind: 'status',
                dataJson: JSON.stringify({
                  status: 'planned',
                  version: current.planVersion,
                }),
              },
            });
            this.bus.publish(entry);
          }
          scope.closeTurn();
          return text(
            `Piano identico alla versione ${current.planVersion}. Turno chiuso: termina ora.`,
          );
        }

        const version = current.planVersion + 1;
        const entry = await this.prisma.$transaction(async (tx) => {
          const { count } = await tx.mission.updateMany({
            where: { id: scope.mission.id, status: 'briefing' },
            data: {
              status: 'planned',
              title: parsed.data.title,
              planJson: canonical,
              planVersion: version,
              waitJson: null,
            },
          });
          if (!count) throw new Error('not-briefing');
          return tx.missionEntry.create({
            data: {
              missionId: scope.mission.id,
              kind: 'plan',
              dataJson: JSON.stringify({ version, plan: parsed.data }),
            },
          });
        }).catch((error: unknown) => {
          if (error instanceof Error && error.message === 'not-briefing') {
            return null;
          }
          throw error;
        });
        if (!entry) {
          return failure('La missione non è più nel briefing: il piano non è stato salvato.');
        }
        this.bus.publish(entry);
        scope.closeTurn();
        return text(
          `Piano salvato come versione ${version}. Turno chiuso: termina ora senza altro testo.`,
        );
      },
      { annotations: { readOnlyHint: false } },
    );
  }
}
