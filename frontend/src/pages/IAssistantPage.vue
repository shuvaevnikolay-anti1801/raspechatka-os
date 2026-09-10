<template>
  <section class="page assistant-page">
    <div class="page-heading">
      <div><h1>I Assistant</h1></div>
      <span class="assistant-status">В разработке</span>
    </div>

    <article class="assistant-shell">
      <div class="assistant-welcome">
        <div class="assistant-mark">I</div>
        <h2>Помощник Raspechatka OS</h2>
        <p>
          Здесь появится рабочий чат с искусственным интеллектом, который сможет
          анализировать данные системы и помогать в управлении бизнесом.
        </p>
      </div>
      <div class="assistant-suggestions">
        <span>Спросить о продажах</span>
        <span>Найти отклонения</span>
        <span>Подготовить сводку</span>
      </div>
      <div class="assistant-composer">
        <textarea disabled rows="2" placeholder="I Assistant пока готовится к запуску"></textarea>
        <button disabled aria-label="Отправить">↑</button>
      </div>
      <small class="assistant-note">Подключение API и доступ к данным будут реализованы отдельным этапом.</small>
    </article>
  </section>
</template>
