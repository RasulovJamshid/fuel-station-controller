import { IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SaveServiceConfigDto {
    @ApiProperty({
        description: 'Complete dispenser-service site configuration',
        type: 'object',
        additionalProperties: true,
    })
    @IsObject()
    config: Record<string, unknown>;
}
