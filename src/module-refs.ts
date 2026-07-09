import type { ModuleRecord } from "./power";

export function getModuleReference(modules: ModuleRecord[], target: ModuleRecord) {
  let count = 0;

  for (const module of modules) {
    if (module.blueprintId === target.blueprintId) {
      count += 1;
    }

    if (module === target) {
      return `${target.blueprintId}-${count}`;
    }
  }

  return `${target.blueprintId}-1`;
}

export function getNextModuleReference(modules: ModuleRecord[], blueprintId: string) {
  const count = modules.filter((module) => module.blueprintId === blueprintId).length;
  return `${blueprintId}-${count + 1}`;
}

export function findModuleByReference(modules: ModuleRecord[], value: string) {
  return modules.find((module) => {
    const reference = getModuleReference(modules, module);
    return module.id === value || module.displayName === value || reference === value;
  });
}
