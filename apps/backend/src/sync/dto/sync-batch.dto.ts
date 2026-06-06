import { IsArray, IsString, IsUUID, IsObject, IsNumber, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class SyncRecordDto {
    @ApiProperty({ description: 'Unique record UUID for idempotency' })
    @IsUUID()
    id: string;

    @ApiProperty({ enum: ['transaction', 'shift', 'reservoir_reading', 'price_change', 'health_event'] })
    @IsString()
    entity_type: string;

    @ApiProperty()
    @IsString()
    entity_id: string;

    @ApiProperty()
    @IsObject()
    payload: Record<string, unknown>;

    @ApiProperty({ description: 'Unix milliseconds' })
    @IsNumber()
    created_at: number;
}

export class SyncBatchDto {
    @ApiProperty({ type: [SyncRecordDto] })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SyncRecordDto)
    records: SyncRecordDto[];
}
