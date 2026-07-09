import type { ModuleRecord } from "./power";
import { getModuleCurrentPowerDrawKw } from "./power";
import { findModuleByReference, getModuleReference, getNextModuleReference } from "./module-refs";

export type InventoryStore = {
  resources: Record<string, number>;
};

export type BlueprintOutput = {
  itemType?: string;
  moduleType?: string;
  quantity?: number;
};

export type BlueprintRequiredFacility = {
  moduleType?: string;
  minimumLevel?: number;
};

export type BlueprintRecord = {
  id: string;
  blueprintId: string;
  displayName: string;
  description?: string;
  status?: string;
  output?: BlueprintOutput;
  inputs?: Record<string, number>;
  productionCost?: Record<string, number>;
  requiredFacility?: BlueprintRequiredFacility;
  buildTicks?: number;
  prerequisites?: string[];
  unlocks?: string[];
  repeatable?: boolean;
  runtimeAttributes?: Record<string, unknown>;
  capabilities?: string[];
};

export type ConstructionJob = {
  blueprintId: string;
  outputModuleId: string;
  outputModuleRef: string;
  outputModuleType: string;
  outputDisplayName: string;
  buildTicks: number;
  remainingTicks: number;
  requiredResources: Record<string, number>;
  futureRuntimeAttributes: Record<string, unknown>;
  futureCapabilities: string[];
};

export type ConstructionCheck = {
  label: string;
  ok: boolean;
  details: string;
};

export type ConstructionPlan = {
  blueprintId: string;
  outputModuleType: string;
  outputModuleRef: string;
  outputDisplayName: string;
  resourcesToSpend: Record<string, number>;
  facilityRef?: string;
  facilityDisplayName?: string;
  buildTicks: number;
  checks: ConstructionCheck[];
  canStart: boolean;
  futureRuntimeAttributes: Record<string, unknown>;
  futureCapabilities: string[];
};

type ModuleWithRuntime = ModuleRecord & {
  runtimeAttributes: Record<string, unknown> & {
    status?: string;
    currentEnergyKwh?: number;
    constructionJob?: ConstructionJob;
  };
};

function getModuleStatus(module: ModuleRecord) {
  const status = (module.runtimeAttributes as Record<string, unknown>).status;
  return typeof status === "string" ? status : "offline";
}

function isOnlineStatus(status: string) {
  return status === "online" || status === "active";
}

function findFacility(modules: ModuleRecord[], moduleType?: string) {
  if (!moduleType) {
    return null;
  }

  return modules.find((module) => module.blueprintId === moduleType) ?? null;
}

function findSupplyModule(modules: ModuleRecord[]) {
  return modules.find((module) => module.blueprintId === "supply-cache" || module.capabilities.includes("storage")) ?? null;
}

function hasUsableBattery(modules: ModuleRecord[]) {
  return modules.some((module) => {
    if (module.blueprintId !== "basic-battery" && !module.capabilities.includes("power-storage")) {
      return false;
    }

    const currentEnergy = (module.runtimeAttributes as Record<string, unknown>).currentEnergyKwh;
    return typeof currentEnergy === "number" && currentEnergy > 0;
  });
}

function prerequisitesMet(modules: ModuleRecord[], prerequisites: string[]) {
  return prerequisites.every((required) =>
    modules.some((module) => module.blueprintId === required || module.capabilities.includes(required)),
  );
}

function inventoryHasResources(inventory: InventoryStore, requiredResources: Record<string, number>) {
  return Object.entries(requiredResources).every(([resourceType, requiredAmount]) => {
    return (inventory.resources[resourceType] ?? 0) >= requiredAmount;
  });
}

function getMissingResources(inventory: InventoryStore, requiredResources: Record<string, number>) {
  return Object.entries(requiredResources)
    .filter(([resourceType, requiredAmount]) => (inventory.resources[resourceType] ?? 0) < requiredAmount)
    .map(([resourceType, requiredAmount]) => {
      const currentAmount = inventory.resources[resourceType] ?? 0;
      return `${resourceType} (${currentAmount}/${requiredAmount})`;
    });
}

function isBuildableBlueprint(blueprint: BlueprintRecord) {
  return blueprint.status === "published" && blueprint.output?.itemType === "module" && Boolean(blueprint.output.moduleType);
}

export function buildConstructionPlan(blueprint: BlueprintRecord, modules: ModuleRecord[], inventory: InventoryStore): ConstructionPlan {
  const requiredResources = blueprint.inputs ?? {};
  const requiredFacilityType = blueprint.requiredFacility?.moduleType;
  const facility = findFacility(modules, requiredFacilityType);
  const facilityRef = facility ? getModuleReference(modules, facility) : undefined;
  const supplyModule = findSupplyModule(modules);
  const supplyRef = supplyModule ? getModuleReference(modules, supplyModule) : undefined;
  const outputModuleType = blueprint.output?.moduleType ?? blueprint.blueprintId;
  const outputModuleRef = getNextModuleReference(modules, outputModuleType);
  const outputDisplayName = outputModuleRef;
  const buildTicks = blueprint.buildTicks ?? 0;
  const facilityStatus = facility ? getModuleStatus(facility) : "missing";
  const facilityJob = facility ? (facility.runtimeAttributes as ModuleWithRuntime["runtimeAttributes"]).constructionJob : undefined;
  const supplyStatus = supplyModule ? getModuleStatus(supplyModule) : "missing";
  const prerequisites = blueprint.prerequisites ?? [];
  const missingResources = getMissingResources(inventory, requiredResources);

  const checks: ConstructionCheck[] = [
    {
      label: "Blueprint buildable",
      ok: isBuildableBlueprint(blueprint),
      details: isBuildableBlueprint(blueprint)
        ? `${blueprint.blueprintId} is published and produces a module.`
        : `${blueprint.blueprintId} is not a published buildable module blueprint.`,
    },
    {
      label: "Required facility exists",
      ok: Boolean(facility),
      details: facility
        ? `${facility.displayName} is available as ${facilityRef}.`
        : `Missing required facility ${requiredFacilityType ?? "unknown"}.`,
    },
    {
      label: "Facility available",
      ok: Boolean(facility) && isOnlineStatus(facilityStatus) && !facilityJob,
      details: !facility
        ? "Facility is missing."
        : facilityJob
          ? `${facilityRef} is already busy with ${facilityJob.blueprintId}.`
          : isOnlineStatus(facilityStatus)
            ? `${facilityRef} is ${facilityStatus} and idle.`
            : `${facilityRef} is ${facilityStatus}.`,
    },
    {
      label: "Supply cache online",
      ok: Boolean(supplyModule) && isOnlineStatus(supplyStatus),
      details: !supplyModule
        ? "Missing supply cache or logistics module."
        : isOnlineStatus(supplyStatus)
          ? `${supplyRef} is ${supplyStatus}.`
          : `${supplyRef} is ${supplyStatus}.`,
    },
    {
      label: "Prerequisites met",
      ok: prerequisitesMet(modules, prerequisites),
      details:
        prerequisites.length === 0
          ? "No prerequisites required."
          : prerequisitesMet(modules, prerequisites)
            ? `All prerequisites are present: ${prerequisites.join(", ")}.`
            : `Missing one or more prerequisites: ${prerequisites.join(", ")}.`,
    },
    {
      label: "Inventory contains resources",
      ok: inventoryHasResources(inventory, requiredResources),
      details:
        Object.keys(requiredResources).length === 0
          ? "No resources required."
          : inventoryHasResources(inventory, requiredResources)
            ? "Local inventory has all required resources."
            : `Missing resources: ${missingResources.join(", ")}.`,
    },
    {
      label: "Usable power available",
      ok: hasUsableBattery(modules),
      details: hasUsableBattery(modules)
        ? "At least one battery has usable stored energy."
        : "No usable battery energy is available.",
    },
  ];

  return {
    blueprintId: blueprint.blueprintId,
    outputModuleType,
    outputModuleRef,
    outputDisplayName,
    resourcesToSpend: requiredResources,
    facilityRef,
    facilityDisplayName: facility?.displayName,
    buildTicks,
    checks,
    canStart: checks.every((check) => check.ok),
    futureRuntimeAttributes: {
      ...(blueprint.runtimeAttributes ?? {}),
      status: "online",
    },
    futureCapabilities: [...(blueprint.capabilities ?? [])],
  };
}

export function spendInventory(inventory: InventoryStore, resourcesToSpend: Record<string, number>) {
  const nextInventory: InventoryStore = {
    resources: { ...inventory.resources },
  };

  for (const [resourceType, amount] of Object.entries(resourcesToSpend)) {
    nextInventory.resources[resourceType] = (nextInventory.resources[resourceType] ?? 0) - amount;
  }

  return nextInventory;
}

export function startConstruction(modules: ModuleRecord[], plan: ConstructionPlan) {
  const nextModules = structuredClone(modules) as ModuleRecord[];
  const facility = findModuleByReference(nextModules, plan.facilityRef ?? "");

  if (!facility) {
    throw new Error("Construction facility disappeared before the job could start.");
  }

  const facilityRuntime = facility.runtimeAttributes as ModuleWithRuntime["runtimeAttributes"];
  facilityRuntime.status = "active";
  facilityRuntime.constructionJob = {
    blueprintId: plan.blueprintId,
    outputModuleId: `module_${crypto.randomUUID()}`,
    outputModuleRef: plan.outputModuleRef,
    outputModuleType: plan.outputModuleType,
    outputDisplayName: plan.outputDisplayName,
    buildTicks: plan.buildTicks,
    remainingTicks: plan.buildTicks,
    requiredResources: { ...plan.resourcesToSpend },
    futureRuntimeAttributes: structuredClone(plan.futureRuntimeAttributes) as Record<string, unknown>,
    futureCapabilities: [...plan.futureCapabilities],
  };

  return nextModules;
}

export type ConstructionTickResult = {
  modules: ModuleRecord[];
  completedModules: string[];
  advancedJobs: string[];
};

export function advanceConstructionJobs(modules: ModuleRecord[], poweredModuleIds: string[]) {
  const nextModules = structuredClone(modules) as ModuleRecord[];
  const completedModules: string[] = [];
  const advancedJobs: string[] = [];

  for (const facility of nextModules) {
    const runtimeAttributes = facility.runtimeAttributes as ModuleWithRuntime["runtimeAttributes"];
    const job = runtimeAttributes.constructionJob;

    if (!job) {
      continue;
    }

    if (!poweredModuleIds.includes(facility.id) || getModuleCurrentPowerDrawKw(facility) <= 0) {
      continue;
    }

    job.remainingTicks -= 1;
    advancedJobs.push(job.outputModuleRef);

    if (job.remainingTicks > 0) {
      continue;
    }

    const newModule: ModuleRecord = {
      id: job.outputModuleId,
      blueprintId: job.outputModuleType,
      displayName: job.outputDisplayName,
      connectedTo: [],
      runtimeAttributes: structuredClone(job.futureRuntimeAttributes) as Record<string, unknown>,
      capabilities: [...job.futureCapabilities],
    };

    nextModules.push(newModule);
    delete runtimeAttributes.constructionJob;
    runtimeAttributes.status = "online";
    completedModules.push(job.outputModuleRef);
  }

  return {
    modules: nextModules,
    completedModules,
    advancedJobs,
  } satisfies ConstructionTickResult;
}

export function cancelConstruction(modules: ModuleRecord[], facilityReference: string) {
  const nextModules = structuredClone(modules) as ModuleRecord[];
  const facility = findModuleByReference(nextModules, facilityReference);

  if (!facility) {
    throw new Error(`Module "${facilityReference}" not found.`);
  }

  const runtimeAttributes = facility.runtimeAttributes as ModuleWithRuntime["runtimeAttributes"];
  const job = runtimeAttributes.constructionJob;

  if (!job) {
    throw new Error(`${getModuleReference(nextModules, facility)} has no active construction job.`);
  }

  delete runtimeAttributes.constructionJob;
  runtimeAttributes.status = "online";

  return {
    modules: nextModules,
    facilityRef: getModuleReference(nextModules, facility),
    canceledJob: job.outputModuleRef,
  };
}
