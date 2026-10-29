import { Injectable } from '@nestjs/common';
import type { MissionEntry } from '../generated/prisma/client.js';

type Listener = (entry: MissionEntry) => void;

/** Hands new mission log entries to the clients following that mission. In memory: one instance. */
@Injectable()
export class MissionEventBus {
  private readonly missions = new Map<number, Set<Listener>>();

  /** Returns the function that unsubscribes. */
  subscribe(missionId: number, listener: Listener) {
    let set = this.missions.get(missionId);
    if (!set) this.missions.set(missionId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.missions.get(missionId) === set) {
        this.missions.delete(missionId);
      }
    };
  }

  publish(entry: MissionEntry) {
    for (const listener of this.missions.get(entry.missionId) ?? []) {
      listener(entry);
    }
  }
}
