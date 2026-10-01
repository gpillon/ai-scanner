import { Label, Spinner } from '@patternfly/react-core';
import CheckCircleIcon from '@patternfly/react-icons/dist/esm/icons/check-circle-icon';
import ExclamationCircleIcon from '@patternfly/react-icons/dist/esm/icons/exclamation-circle-icon';
import HourglassHalfIcon from '@patternfly/react-icons/dist/esm/icons/hourglass-half-icon';
import ThermometerHalfIcon from '@patternfly/react-icons/dist/esm/icons/thermometer-half-icon';
import type { ScanState } from '../api';

export function ScanStateLabel({ state }: { state: ScanState | 'unknown' }) {
  switch (state) {
    case 'queued':
      return <Label icon={<HourglassHalfIcon />}>Queued</Label>;
    case 'warming':
      return (
        <Label color="orange" icon={<ThermometerHalfIcon />} title="The model is being woken up before the first Attempt">
          Warming up
        </Label>
      );
    case 'running':
      return (
        <Label color="blue" icon={<Spinner size="sm" aria-label="Running" />}>
          Running
        </Label>
      );
    case 'succeeded':
      return (
        <Label color="green" icon={<CheckCircleIcon />}>
          Succeeded
        </Label>
      );
    case 'failed':
      return (
        <Label color="red" icon={<ExclamationCircleIcon />}>
          Failed
        </Label>
      );
    default:
      return <Label variant="outline">Unknown</Label>;
  }
}

/** Scans that have not finished change on their own: their status is worth polling. */
export const isActive = (state: ScanState) => state === 'queued' || state === 'warming' || state === 'running';

export function formatTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}
