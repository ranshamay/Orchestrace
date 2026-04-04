import { useEffect, useState } from 'react';
import { fetchModels } from '../../lib/api';

export function useProviderModels(workProvider: string, workModel: string, setWorkModel: (model: string) => void) {
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});

  useEffect(() => {
    const loadModels = async () => {
      if (!workProvider) {
        return;
      }

      try {
        const response = await fetchModels(workProvider);
        setProviderModels((previous) => ({
          ...previous,
          [workProvider]: response.models,
        }));

        if (!workModel && response.models.length > 0) {
          setWorkModel(response.models[0]);
        }
      } catch {
        setProviderModels((previous) => ({
          ...previous,
          [workProvider]: [],
        }));
      }
    };

    void loadModels();
  }, [setWorkModel, workModel, workProvider]);

  return {
    providerModels,
    currentModels: providerModels[workProvider] ?? [],
  };
}