import { SetMetadata } from '@nestjs/common';

export const STATION_RESPONSE = 'stationResponse';
export type StationResponseFormat = 'sync' | 'prices';

// Old station binaries cannot be updated remotely. Their original response
// formats must remain available independently of the dashboard API envelope.
export const StationResponse = (format: StationResponseFormat) => SetMetadata(STATION_RESPONSE, format);
