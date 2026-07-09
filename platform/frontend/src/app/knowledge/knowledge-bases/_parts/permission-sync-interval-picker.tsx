// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
"use client";

import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const INTERVAL_OPTIONS: { seconds: number; label: string }[] = [
  { seconds: 15 * 60, label: "Every 15 minutes" },
  { seconds: 30 * 60, label: "Every 30 minutes" },
  { seconds: 60 * 60, label: "Every hour" },
  { seconds: 3 * 60 * 60, label: "Every 3 hours" },
  { seconds: 6 * 60 * 60, label: "Every 6 hours" },
  { seconds: 12 * 60 * 60, label: "Every 12 hours" },
  { seconds: 24 * 60 * 60, label: "Every 24 hours" },
];

export function PermissionSyncIntervalPicker({
  form,
  name,
  connectorTypeLabel,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  name: string;
  connectorTypeLabel: string;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>Permissions Sync Frequency</FormLabel>
          <Select
            value={String(field.value ?? "")}
            onValueChange={(value) => field.onChange(Number(value))}
          >
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select an interval" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {INTERVAL_OPTIONS.map((option) => (
                <SelectItem key={option.seconds} value={String(option.seconds)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormDescription>
            Pick how often to sync content permissions with your{" "}
            {connectorTypeLabel} instance
          </FormDescription>
        </FormItem>
      )}
    />
  );
}
