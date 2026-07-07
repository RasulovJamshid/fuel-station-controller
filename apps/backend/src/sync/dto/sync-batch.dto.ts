import { IsArray, IsString, IsUUID, IsObject, IsNumber, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class SyncRecordDto {
    @ApiProperty({ description: 'Unique record UUID for idempotency', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
    @IsUUID()
    id: string;

    @ApiProperty({ description: 'Type of entity carried by this record', enum: ['transaction', 'shift', 'reservoir_reading', 'price_change', 'health_event'], example: 'transaction' })
    @IsString()
    entity_type: string;

    @ApiProperty({ description: 'Station-local identifier of the entity being synced', example: 'tx-000123' })
    @IsString()
    entity_id: string;

    @ApiProperty({ description: 'Entity payload; shape depends on entity_type', type: 'object', additionalProperties: true })
    @IsObject()
    payload: Record<string, unknown>;

    @ApiProperty({ description: 'Record creation time, Unix milliseconds', example: 1720353600000 })
    @IsNumber()
    created_at: number;
}

export class SyncBatchDto {
    @ApiProperty({ description: 'Batch of sync records to ingest', type: [SyncRecordDto] })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SyncRecordDto)
    records: SyncRecordDto[];
}
