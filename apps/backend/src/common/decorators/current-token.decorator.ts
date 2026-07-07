import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** The authenticated integration token, as attached to the request by ApiTokenGuard. */
export interface AuthenticatedToken {
    id:         string;
    companyId:  string;
    scopes:     string[];
    oilBaseIds: string[];
    stationIds: string[];
}

export const CurrentToken = createParamDecorator(
    (_data: unknown, ctx: ExecutionContext): AuthenticatedToken =>
        ctx.switchToHttp().getRequest().apiToken,
);
