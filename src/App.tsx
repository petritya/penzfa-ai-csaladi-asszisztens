import { hasSupabaseConfig } from './lib/supabase'

export default function App() {
  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">Pénzfa</p>
        <h1>AI családi asszisztens</h1>
        <p>Az MVP technikai alapja elkészült.</p>
        <div className={hasSupabaseConfig ? 'status ok' : 'status'}>
          Supabase: {hasSupabaseConfig ? 'beállítva' : 'még nincs összekötve'}
        </div>
      </section>
    </main>
  )
}
