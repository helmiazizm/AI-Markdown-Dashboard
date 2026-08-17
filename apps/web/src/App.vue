<template>
  <div class="app-shell">
    <header class="site-header">
      <RouterLink class="wordmark" to="/" aria-label="Fieldboard home">
        <span class="wordmark-mark" aria-hidden="true">F/B</span>
        <span>Fieldboard</span>
      </RouterLink>
      <nav class="system-navigation" aria-label="System navigation">
        <RouterLink to="/repository">Repository sync</RouterLink>
        <div class="system-readout"><span class="pulse-dot" aria-hidden="true"></span>Local analytical instrument</div>
      </nav>
    </header>
    <main><RouterView /></main>
    <footer class="site-footer">
      <span>DuckDB ↗ MinIO</span><span>Cline ↗ OpenRouter</span><span>Snapshot 2026.03.19</span>
    </footer>
  </div>
</template>
