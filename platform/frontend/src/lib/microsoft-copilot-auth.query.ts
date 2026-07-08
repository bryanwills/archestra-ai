import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

const { microsoftCopilotDeviceAuthStart, microsoftCopilotDeviceAuthPoll } =
  archestraApiSdk;

export type MicrosoftCopilotDeviceStart =
  archestraApiTypes.MicrosoftCopilotDeviceAuthStartResponses["200"];
export type MicrosoftCopilotDevicePoll =
  archestraApiTypes.MicrosoftCopilotDeviceAuthPollResponses["200"];

export function useStartMicrosoftCopilotDeviceFlow() {
  return useMutation({
    mutationFn: async (): Promise<MicrosoftCopilotDeviceStart | null> => {
      const { data, error } = await microsoftCopilotDeviceAuthStart();
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}

export function usePollMicrosoftCopilotDeviceFlow() {
  return useMutation({
    mutationFn: async (
      deviceCode: string,
    ): Promise<MicrosoftCopilotDevicePoll | null> => {
      const { data, error } = await microsoftCopilotDeviceAuthPoll({
        body: { deviceCode },
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
  });
}
