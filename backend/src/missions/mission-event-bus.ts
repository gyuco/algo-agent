import { Injectable } from '@nestjs/common';
import type { MissionEntry } from '../generated/prisma/client.js';

type Listener = (entry: MissionEntry) => void;

/** Hands new mission log entries to the clients following that mission. In memory: one instance. */
@Injectable()
export class MissionEventBus {
  private readonly missions = new Map<number, Set<Listener>>();
  private readonly users = new Map<number, Set<Listener>>();
  /** Each mission's user, so a published entry reaches their stream too. */
  private readonly owners = new Map<number, number>();

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

  /** The entries of every mission of one user: the notifications stream (§7.1). */
  subscribeUser(userId: number, listener: Listener) {
    let set = this.users.get(userId);
    if (!set) this.users.set(userId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.users.get(userId) === set) {
        this.users.delete(userId);
      }
    };
  }

  remember(missionId: number, userId: number) {
    this.owners.set(missionId, userId);
  }

  publish(entry: MissionEntry) {
    for (const listener of this.missions.get(entry.missionId) ?? []) {
      listener(entry);
    }
    const owner = this.owners.get(entry.missionId);
    if (owner === undefined) return;
    for (const listener of this.users.get(owner) ?? []) {
      listener(entry);
    }
  }
}
