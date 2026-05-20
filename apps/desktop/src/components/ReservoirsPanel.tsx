import { TankGauge } from "./TankGauge";
import { AtgPanel } from "./AtgPanel";

export function ReservoirsPanel() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row lg:gap-6">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Tank levels</h2>
          <p className="mt-0.5 text-sm text-slate-500">Visual levels for each underground reservoir.</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-2">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-4 auto-rows-max">
            <TankGauge label="AI-92" levelPct={72} subtitle="Tank 1" />
            <TankGauge label="AI-95" levelPct={45} subtitle="Tank 2" />
            <TankGauge label="Diesel" levelPct={61} subtitle="Tank 3" />
            <TankGauge label="Diesel (Premium)" levelPct={88} subtitle="Tank 4" />
            <TankGauge label="AI-80" levelPct={25} subtitle="Tank 5" />
            <TankGauge label="AI-98" levelPct={90} subtitle="Tank 6" />
          </div>
        </div>
      </section>

      <section className="flex min-h-[min(40vh,22rem)] shrink-0 flex-col lg:min-h-0 lg:w-[min(100%,26rem)] xl:w-[28rem]">
        <AtgPanel className="min-h-0 flex-1" />
      </section>
    </div>
  );
}
