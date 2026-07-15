import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { InventoryStore } from "./construction";
import type { ModuleRecord } from "./power";

export type StarterHumanRecord = {
  id: string;
  displayName: string;
  locationModuleId: string;
};

export type HabitatAlertContractRecord = {
  schemaVersion: string;
  schema: Record<string, unknown>;
};

export type HabitatContractsRecord = {
  alerts: HabitatAlertContractRecord;
};

export type HabitatStateBootstrap = {
  registration: RegistrationRecord;
  modules: ModuleRecord[];
  humans: StarterHumanRecord[];
};

export type RegistrationRecord = {
  habitatUuid: string;
  displayName: string;
  habitatId: string;
  apiToken?: string;
  baseUrl: string;
  registeredAt: string;
  lastSyncedAt: string;
  starterModules: ModuleRecord[];
  starterHumans?: StarterHumanRecord[];
  contracts?: HabitatContractsRecord;
  blueprints: unknown[];
  lastStatus?: unknown;
};

function getDatabase() {
  const database = new Database(getDatabaseFile(), { create: true });
  database.exec(`
    CREATE TABLE IF NOT EXISTS registration (
      storage_key TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS modules (
      sort_order INTEGER PRIMARY KEY,
      module_id TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS humans (
      sort_order INTEGER PRIMARY KEY,
      human_id TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory (
      resource_type TEXT PRIMARY KEY,
      quantity INTEGER NOT NULL
    );
  `);

  return database;
}

function withDatabase<T>(callback: (database: Database) => T) {
  const database = getDatabase();

  try {
    return callback(database);
  } finally {
    database.close(false);
  }
}

export function getDatabaseFile() {
  return join(process.cwd(), "habitat.sqlite");
}

export async function readRegistration() {
  return withDatabase((database) => {
    const row = database
      .query("SELECT record_json FROM registration WHERE storage_key = ?1")
      .get("current") as { record_json: string } | null;

    return row ? (JSON.parse(row.record_json) as RegistrationRecord) : null;
  });
}

export async function writeRegistration(record: RegistrationRecord) {
  withDatabase((database) => {
    database
      .query("INSERT OR REPLACE INTO registration (storage_key, record_json) VALUES (?1, ?2)")
      .run("current", JSON.stringify(record));
  });
}

export async function writeHabitatState({ registration, modules, humans }: HabitatStateBootstrap) {
  withDatabase((database) => {
    const insertModule = database.query(
      "INSERT INTO modules (sort_order, module_id, record_json) VALUES (?1, ?2, ?3)",
    );
    const insertHuman = database.query(
      "INSERT INTO humans (sort_order, human_id, record_json) VALUES (?1, ?2, ?3)",
    );

    database.transaction(() => {
      database.query("INSERT OR REPLACE INTO registration (storage_key, record_json) VALUES (?1, ?2)").run(
        "current",
        JSON.stringify(registration),
      );
      database.exec("DELETE FROM modules");
      database.exec("DELETE FROM humans");

      modules.forEach((module, index) => {
        insertModule.run(index, module.id, JSON.stringify(module));
      });

      humans.forEach((human, index) => {
        insertHuman.run(index, human.id, JSON.stringify(human));
      });
    })();
  });
}

export async function removeRegistration() {
  withDatabase((database) => {
    database.query("DELETE FROM registration WHERE storage_key = ?1").run("current");
  });
}

export async function readModules() {
  return withDatabase((database) => {
    const rows = database
      .query("SELECT record_json FROM modules ORDER BY sort_order ASC")
      .all() as Array<{ record_json: string }>;

    return rows.map((row) => JSON.parse(row.record_json) as ModuleRecord);
  });
}

export async function writeModules(modules: ModuleRecord[]) {
  withDatabase((database) => {
    const insert = database.query(
      "INSERT INTO modules (sort_order, module_id, record_json) VALUES (?1, ?2, ?3)",
    );

    database.transaction(() => {
      database.exec("DELETE FROM modules");

      modules.forEach((module, index) => {
        insert.run(index, module.id, JSON.stringify(module));
      });
    })();
  });
}

export async function removeModules() {
  withDatabase((database) => {
    database.exec("DELETE FROM modules");
  });
}

export async function readHumans() {
  return withDatabase((database) => {
    const rows = database
      .query("SELECT record_json FROM humans ORDER BY sort_order ASC")
      .all() as Array<{ record_json: string }>;

    return rows.map((row) => JSON.parse(row.record_json) as StarterHumanRecord);
  });
}

export async function writeHumans(humans: StarterHumanRecord[]) {
  withDatabase((database) => {
    const insert = database.query(
      "INSERT INTO humans (sort_order, human_id, record_json) VALUES (?1, ?2, ?3)",
    );

    database.transaction(() => {
      database.exec("DELETE FROM humans");

      humans.forEach((human, index) => {
        insert.run(index, human.id, JSON.stringify(human));
      });
    })();
  });
}

export async function removeHumans() {
  withDatabase((database) => {
    database.exec("DELETE FROM humans");
  });
}

export async function readInventory() {
  return withDatabase((database) => {
    const rows = database
      .query("SELECT resource_type, quantity FROM inventory ORDER BY resource_type ASC")
      .all() as Array<{ resource_type: string; quantity: number }>;

    const resources = Object.fromEntries(rows.map((row) => [row.resource_type, row.quantity]));

    return {
      resources,
    } satisfies InventoryStore;
  });
}

export async function writeInventory(inventory: InventoryStore) {
  withDatabase((database) => {
    const insert = database.query(
      "INSERT INTO inventory (resource_type, quantity) VALUES (?1, ?2)",
    );

    database.transaction(() => {
      database.exec("DELETE FROM inventory");

      for (const [resourceType, quantity] of Object.entries(inventory.resources)) {
        insert.run(resourceType, quantity);
      }
    })();
  });
}

export async function removeInventory() {
  withDatabase((database) => {
    database.exec("DELETE FROM inventory");
  });
}
