import type { InventoryStore } from "./construction";
import type {
  HabitatContractsRecord,
  HabitatStateBootstrap,
  RegistrationRecord,
  StarterHumanRecord,
} from "./local-state";
import type { ModuleRecord } from "./power";
import type { BlueprintRecord } from "./construction";
import type { SolarIrradianceResponse } from "./solar";
import type { WorldScanResponse } from "./scan";

export type { RegistrationRecord } from "./local-state";
export type { StarterHumanRecord, HabitatContractsRecord } from "./local-state";
export type { HabitatStateBootstrap } from "./local-state";

export type Habitat = {
  id: string;
  habitatSlug: string;
  displayName: string;
  catalogVersion: string;
  status: string;
  lastSeenAt?: string | null;
};

export type HabitatRegistrationResponse = {
  habitatId: string;
  starterModules: ModuleRecord[];
  starterHumans: StarterHumanRecord[];
  contracts: HabitatContractsRecord;
  blueprints: unknown[];
  apiToken?: string;
};

export type HabitatResponse = {
  habitat: Habitat;
};

export type BlueprintCatalogResponse = {
  blueprints: BlueprintRecord[];
};

export type BlueprintResponse = {
  blueprint: BlueprintRecord;
};

export type ResourceCatalogEntry = {
  resourceType: string;
  displayName?: string;
  description?: string;
  category?: string;
};

export type ResourceCatalogResponse = {
  resources: ResourceCatalogEntry[];
};

export type WorldScanRequest = {
  x: number;
  y: number;
  sensorStrength: number;
  radiusTiles: number;
};

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_API_BASE_URL = "http://localhost:8787";

export function getApiBaseUrl() {
  return (
    Bun.env.HABITAT_API_BASE_URL ??
    Bun.env.HABITAT_WORLD_API_BASE_URL ??
    DEFAULT_API_BASE_URL
  ).replace(/\/+$/, "");
}

async function requestApi<T>(path: string, options: RequestInit = {}) {
  let response: Response;

  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    const details = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`Unable to reach the Habitat API at ${getApiBaseUrl()}.${details}`);
  }

  const text = await response.text();
  if (!response.ok) {
    const details = text ? ` ${text}` : "";
    throw new ApiClientError(response.status, `Habitat API request failed with ${response.status}.${details}`);
  }

  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function readRegistration() {
  const response = await requestApi<{ registration: RegistrationRecord | null }>("/registration");
  return response.registration;
}

export async function writeRegistration(record: RegistrationRecord) {
  await requestApi("/registration", {
    method: "PUT",
    body: JSON.stringify({ registration: record }),
  });
}

export async function bootstrapRegistration(payload: HabitatStateBootstrap) {
  try {
    await requestApi("/registration/bootstrap", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    return;
  } catch (error) {
    if (!(error instanceof ApiClientError) || error.status !== 404) {
      throw error;
    }
  }

  // Older Habitat API deployments do not have the atomic bootstrap route yet.
  await writeRegistration(payload.registration);
  await writeModules(payload.modules);
  try {
    await writeHumans(payload.humans);
  } catch (error) {
    if (!(error instanceof ApiClientError) || error.status !== 404) {
      throw error;
    }
  }
}

export async function removeRegistration() {
  await requestApi("/registration", { method: "DELETE" });
}

export async function readModules() {
  const response = await requestApi<{ modules: ModuleRecord[] }>("/modules");
  return response.modules ?? [];
}

export async function writeModules(modules: ModuleRecord[]) {
  await requestApi("/modules", {
    method: "PUT",
    body: JSON.stringify({ modules }),
  });
}

export async function removeModules() {
  await requestApi("/modules", { method: "DELETE" });
}

export async function readHumans() {
  const response = await requestApi<{ humans: StarterHumanRecord[] }>("/humans");
  return response.humans ?? [];
}

export async function writeHumans(humans: StarterHumanRecord[]) {
  await requestApi("/humans", {
    method: "PUT",
    body: JSON.stringify({ humans }),
  });
}

export async function removeHumans() {
  try {
    await requestApi("/humans", { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof ApiClientError) || error.status !== 404) {
      throw error;
    }
  }
}

export async function readInventory() {
  const response = await requestApi<{ inventory: InventoryStore }>("/inventory");
  return response.inventory ?? { resources: {} };
}

export async function writeInventory(inventory: InventoryStore) {
  await requestApi("/inventory", {
    method: "PUT",
    body: JSON.stringify({ inventory }),
  });
}

export async function removeInventory() {
  await requestApi("/inventory", { method: "DELETE" });
}

export async function registerHabitat(payload: { habitatUuid: string; displayName: string }) {
  return requestApi<HabitatRegistrationResponse>("/habitats/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function readHabitatStatus(habitatId: string) {
  return requestApi<HabitatResponse>(`/habitats/${habitatId}`);
}

export async function unregisterHabitat(habitatId: string) {
  await requestApi(`/habitats/${habitatId}`, { method: "DELETE" });
}

export async function readBlueprintCatalog() {
  return requestApi<BlueprintCatalogResponse>("/catalog/blueprints");
}

export async function readBlueprint(blueprintId: string) {
  return requestApi<BlueprintResponse>(`/catalog/blueprints/${encodeURIComponent(blueprintId)}`);
}

export async function readResourceCatalog() {
  return requestApi<ResourceCatalogResponse>("/catalog/resources");
}

export async function readSolarIrradiance() {
  return requestApi<SolarIrradianceResponse>("/world/solar-irradiance");
}

export async function readWorldScan(request: WorldScanRequest) {
  const params = new URLSearchParams({
    x: `${request.x}`,
    y: `${request.y}`,
    sensorStrength: `${request.sensorStrength}`,
    radiusTiles: `${request.radiusTiles}`,
  });

  return requestApi<WorldScanResponse>(`/world/scan?${params.toString()}`);
}
