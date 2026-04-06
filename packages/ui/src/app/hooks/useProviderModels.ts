import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { fetchModels } from '../../lib/api';

export function useProviderModels(
  workProvider: string,
  workModel: string,
  setWorkModel: Dispatch<SetStateAction<string>>,
) {
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});

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
          setWorkModel((current) => (current.length > 0 && response.models.includes(current)
            ? current
            : response.models[0]));
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
      setWorkModel(models[0]);
    }
  }, [providerModels, setWorkModel, workModel, workProvider]);

  return {
    providerModels,
    currentModels: providerModels[workProvider] ?? [],
  };
}