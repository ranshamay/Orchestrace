import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { fetchModels } from '../../lib/api';

export function useProviderModels(
  workProvider: string,
  workModel: string,
  setWorkModel: Dispatch<SetStateAction<string>>,
  preferredModelForProvider?: string,
) {
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});

  const resolveNextModel = (
    models: string[],
    currentModel: string,
    preferredModel?: string,
  ): string => {
    if (models.length === 0) {
      return '';
    }

    if (currentModel.length > 0 && models.includes(currentModel)) {
      return currentModel;
    }

    if (preferredModel && models.includes(preferredModel)) {
      return preferredModel;
    }

    return models[0];
  };

  useEffect(() => {
    if (!workProvider) {
      return;
    }

    let cancelled = false;

    const loadModels = async () => {
      try {
        const response = await fetchModels(workProvider);
        if (cancelled) {
          return;
        }

        setProviderModels((previous) => ({
          ...previous,
          [workProvider]: response.models,
        }));

        if (response.models.length > 0) {
          setWorkModel((current) => resolveNextModel(response.models, current, preferredModelForProvider));
        }
      } catch {
        if (cancelled) {
          return;
        }

        setProviderModels((previous) => ({
          ...previous,
          [workProvider]: [],
        }));
      }
    };

    void loadModels();

    return () => {
      cancelled = true;
    };
  }, [setWorkModel, workProvider]);

  useEffect(() => {
    if (!workProvider) {
      return;
    }

    const models = providerModels[workProvider] ?? [];
    if (models.length === 0) {
      return;
    }

    const hasSelectedModel = workModel.length > 0 && models.includes(workModel);
    if (!hasSelectedModel) {
      setWorkModel((current) => resolveNextModel(models, current, preferredModelForProvider));
    }
  }, [preferredModelForProvider, providerModels, setWorkModel, workModel, workProvider]);

  return {
    providerModels,
    currentModels: providerModels[workProvider] ?? [],
  };
}