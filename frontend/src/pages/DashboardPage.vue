<script setup>
const metrics = [
  { label: "Выручка сегодня", value: "18 473 ₽", delta: "+17%", note: "к прошлому дню", accent: true },
  { label: "Выручка за период", value: "428 960 ₽", delta: "+8%", note: "1–5 сентября" },
  { label: "Средний чек", value: "637 ₽", delta: "+4%", note: "за сегодня" },
];

const days = [
  { name: "Пн", value: 38 },
  { name: "Вт", value: 54 },
  { name: "Ср", value: 46 },
  { name: "Чт", value: 72 },
  { name: "Пт", value: 88 },
  { name: "Сб", value: 64 },
  { name: "Вс", value: 42 },
];
</script>

<template>
  <section class="page dashboard-page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">УПРАВЛЯЮЩИЙ · ВСЕ ТОЧКИ</div>
        <h1>Главная</h1>
        <p>Ключевые показатели сети на сегодня</p>
      </div>
      <div class="heading-actions">
        <span class="demo-badge"><i></i> Демо-данные</span>
        <button class="button button-secondary" type="button">Настроить экран</button>
      </div>
    </div>

    <div class="metric-grid">
      <article v-for="metric in metrics" :key="metric.label" class="metric-card" :class="{ accent: metric.accent }">
        <span class="metric-label">{{ metric.label }}</span>
        <strong>{{ metric.value }}</strong>
        <div><b>{{ metric.delta }}</b> <span>{{ metric.note }}</span></div>
      </article>
      <article class="metric-card compact">
        <span class="metric-label">Заказов сегодня</span>
        <strong>29</strong>
        <div><b>22</b> <span>выполнено</span></div>
      </article>
    </div>

    <div class="dashboard-grid">
      <article class="panel revenue-panel">
        <div class="panel-header">
          <div>
            <span class="panel-kicker">ДИНАМИКА ВЫРУЧКИ</span>
            <h2>Последние 7 дней</h2>
          </div>
          <button class="period-select" type="button">Неделя ⌄</button>
        </div>
        <div class="chart" aria-label="Демонстрационный график выручки">
          <div class="chart-gridlines"><i></i><i></i><i></i><i></i></div>
          <div v-for="day in days" :key="day.name" class="chart-column">
            <div class="bar-wrap"><span class="bar" :style="{ height: `${day.value}%` }"></span></div>
            <small>{{ day.name }}</small>
          </div>
        </div>
        <div class="chart-total"><span>Итого за неделю</span><strong>124 870 ₽</strong></div>
      </article>

      <article class="panel points-panel">
        <div class="panel-header">
          <div>
            <span class="panel-kicker">ТОЧКИ ПРОДАЖ</span>
            <h2>Результат сегодня</h2>
          </div>
          <button class="text-button" type="button">Все точки →</button>
        </div>
        <div class="point-row">
          <span class="rank">01</span><div><b>Тестовая точка</b><small>Москва</small></div><strong>18 473 ₽</strong>
        </div>
        <div class="empty-note">
          <span>＋</span>
          <p>Здесь появятся остальные точки сети и сравнение их показателей.</p>
        </div>
      </article>
    </div>
  </section>
</template>
