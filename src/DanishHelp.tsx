type Props = { onBack: () => void }

// A dán súgó kizárólag a már elérhető MVP funkciókat mutatja be.
// A dán AI-bevitel külön fejlesztési lépés, ezért itt ezt jelezzük.
export default function DanishHelp({ onBack }: Props) {
  return (
    <main className="shell">
      <section className="card help-page">
        <button className="help-back-button" type="button" onClick={onBack}>
          ← Tilbage
        </button>
        <header className="app-header help-header">
          <p className="eyebrow">AI-familieassistent</p>
          <h1>Hjælp</h1>
          <p className="lead">Få overblik over familiens opgaver, aftaler og påmindelser.</p>
          <p className="notice">Du kan nu skrive og indtale opgaver på dansk. Bekræft altid
            oplysninger og tidspunkter, før du gemmer en opgave.</p>
        </header>
        <div className="help-sections">
          <details className="help-section" open>
            <summary>Hvad er AI-familieassistenten?</summary>
            <p>Appen samler familiens opgaver, aftaler og frister. Du kan oprette opgaver,
              få påmindelser, modtage et morgenoverblik og finde tidligere opgaver.</p>
            <div className="help-examples">
              <strong>Begreber</strong>
              <ul>
                <li><strong>Familiebruger:</strong> Har sin egen konto, kan administrere opgaver
                  og modtage notifikationer.</li>
                <li><strong>Familiemedlem uden egen konto:</strong> Har ingen selvstændig adgang.
                  Familiebrugerne administrerer vedkommendes opgaver.</li>
                <li>En familie kan have op til to familiebrugere og flere familiemedlemmer uden egen konto.</li>
              </ul>
            </div>
          </details>
          <details className="help-section">
            <summary>Opret en opgave eller aftale</summary>
            <p>Fortæl, hvad der skal gøres, hvem det drejer sig om, og hvornår.
              Du bliver bedt om at bekræfte, før en opgave gemmes.</p>
            <div className="help-examples">
              <strong>Eksempler på danske beskeder</strong>
              <ul>
                <li>„Jeg skal ringe til revisoren i morgen kl. 10.”</li>
                <li>„Bence skal til kontrol næste tirsdag kl. 10.”</li>
              </ul>
            </div>
          </details>
          <details className="help-section">
            <summary>Påmindelser</summary>
            <p>En påmindelse kan indstilles, når opgaven oprettes, eller senere.
              Hvis den anden familiebruger er ansvarlig, får vedkommende sin egen påmindelse.</p>
            <div className="help-examples">
              <strong>Eksempel på dansk besked</strong>
              <ul><li>„Mind mig om det en time før.”</li></ul>
            </div>
          </details>
          <details className="help-section">
            <summary>Søg og find opgaver</summary>
            <p>Du kan søge efter åbne og afsluttede opgaver og filtrere efter
              familiemedlem, ansvarlig person eller tidspunkt.</p>
            <div className="help-examples">
              <strong>Eksempel på dansk besked</strong>
              <ul><li>„Hvilke åbne opgaver har jeg?”</li></ul>
            </div>
          </details>
          <details className="help-section">
            <summary>Rediger opgaver</summary>
            <p>Du kan ændre en opgaves dato, tidspunkt og påmindelse.
              Hvis der er flere relevante opgaver, vælger du først den rigtige.</p>
          </details>
          <details className="help-section">
            <summary>Afslut eller slet en opgave</summary>
            <p>Appen finder den ønskede opgave og beder om bekræftelse ved
              sletning eller usikre ændringer.</p>
          </details>
          <details className="help-section">
            <summary>Familiebrugere og familiemedlemmer</summary>
            <p>Under Familiemedlemmer kan du tilføje personer uden egen konto.
              Du kan invitere en anden familiebruger via e-mail.</p>
          </details>
          <details className="help-section">
            <summary>Notifikationer, morgenoverblik og installation</summary>
            <p>Notifikationer aktiveres på hver enhed under Konto og notifikationer.
              Tidspunktet for morgenoverblikket ændres under Indstillinger.</p>
            <p>Under Installer på telefonen kan du føje appen til startskærmen.</p>
          </details>
        </div>
      </section>
    </main>
  )
}
