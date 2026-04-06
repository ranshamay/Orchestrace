export function LogsTabView() {
  return (
    <section className="h-full w-full overflow-auto p-6 text-sm text-zinc-300">
      <div className="mx-auto max-w-3xl rounded-md border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="text-base font-semibold text-zinc-100">Logs</h2>
        <p className="mt-2 text-zinc-400">
          Logs view is currently unavailable in this build. Use the Graph tab&apos;s observer panels for
          live diagnostics.
        </p>
      </div>
    </section>
  );
}