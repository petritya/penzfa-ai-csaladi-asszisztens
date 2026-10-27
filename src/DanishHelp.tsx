type Props = { onBack: () => void }

// A dán Súgó az aktuálisan elérhető MVP-műveleteket mutatja be.
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
                      <p>Under Familiemedlemmer kan du tilføje personer uden egen konto.
              Du kan invitere en anden familiebruger via e-mail.</p>
          </details>

          <details className="help-section">
            <summary>Notifikationer, morgenoverblik og installation</summary>
            <p>Notifikationer aktiveres på hver enhed under Konto og notifikationer.
              Tidspunktet for morgenoverblikket ændres under Indstillinger.</p>
            <p>Under Installer på telefonen kan du føje appen til startskærmen.</p>
          </details>

          <details className="help-section" open>
            <summary>Tal kort og tydeligt</summary>
            <p>Ved nye opgaver er det en hjælp at nævne <strong>hvem</strong> (hvis det ikke er dig),
              <strong> hvad der skal gøres</strong>, <strong>hvornår</strong>, og eventuelt
              <strong> en påmindelse</strong>. Brug gerne et udsagnsord.</p>
            <div className="help-examples">
              <strong>Korte eksempler</strong>
              <ul>
                <li>„Jeg skal i banken i morgen kl. 12. Mind mig om det 2 timer før.”</li>
                <li>„Mor skal ringe til håndværkeren på fredag. Mind hende om det dagen før.”</li>
                <li>„Bence skal til kontrol på tirsdag kl. 10.”</li>
              </ul>
            </div>
            <p>Du behøver ikke sige dit eget navn ved dine egne opgaver.
              „I morgen kl. 12 banken” kan være uklart; sig hellere, hvad du vil gøre.
              Du kan stadig tale i hele, naturlige sætninger.</p>
            <p>Korte beskeder kan mindske misforståelser, men de garanterer ikke hurtigere svar.</p>
          </details>

          <details className="help-section" open>
            <summary>De 5 vigtigste funktioner</summary>
            <p>Du kan skrive eller indtale dine beskeder:</p>
            <ol>
              <li><strong>Opret:</strong> Tilføj en opgave eller aftale.</li>
              <li><strong>Søg:</strong> Find dine og familiens opgaver.</li>
              <li><strong>Rediger:</strong> Ændr tidspunkt eller påmindelse.</li>
              <li><strong>Markér som udført:</strong> Afslut en opgave, der er klaret.</li>
              <li><strong>Slet:</strong> Fjern en forkert eller uaktuel opgave.</li>
            </ol>
            <p>Kontrollér oplysningerne, før du bekræfter ændringer. Sletning kræver bekræftelse.</p>
          </details>

          <details className="help-section">
            <summary>1. Opret en opgave eller aftale</summary>
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
            <summary>2. Søg og find opgaver</summary>
            <p>Du kan søge efter åbne og afsluttede opgaver og filtrere efter
              familiemedlem, ansvarlig person eller tidspunkt.</p>
            <div className="help-examples">
              <strong>Eksempel på dansk besked</strong>
              <ul>
                <li>„Hvilke åbne opgaver har jeg?”</li>
                <li>„Hvilke forfaldne opgaver har jeg?”</li>
                <li>„Hvilke opgaver har jeg i denne uge?”</li>
              </ul>
            </div>
          </details>

          <details className="help-section">
            <summary>3. Rediger opgaver</summary>
            <p>Du kan nemmest ændre en opgaves dato, tidspunkt eller påmindelse direkte fra søgeresultaterne.
              På den måde vælger du den rigtige opgave først.</p>
            <ol>
              <li>Søg efter opgaven, for eksempel: „Hvilke åbne opgaver har jeg?”</li>
              <li>Find den opgave, du vil ændre, i søgeresultaterne.</li>
              <li>Vælg <strong>„Rediger dato/tidspunkt”</strong> eller
                <strong> „Rediger påmindelse”</strong> under opgaven.
                Hvis opgaven ikke har en påmindelse, vælg <strong>„Indstil påmindelse”</strong>.</li>
              <li>Skriv eller indtal kun det nye tidspunkt, for eksempel
                „på fredag kl. 10” eller „2 timer før”, og tryk på <strong>Send</strong>.</li>
              <li>Kontrollér ændringen, og bekræft med <strong>„Ja, rediger”</strong>.</li>
            </ol>
            <p>Du kan også bruge en hel sætning, for eksempel:
              „Flyt tandlægen til fredag”. Hvis flere opgaver passer, kan appen bede dig præcisere.</p>
          </details>

          <details className="help-section">
            <summary>4. Markér som udført</summary>
            <p>Når en opgave er klaret, kan du markere den som udført.
              Hvis flere opgaver passer, skal du først vælge den rigtige.
              Bekræft afslutningen, før den gemmes.</p>
            <div className="help-examples">
              <strong>Eksempel</strong>
              <ul><li>„Jeg har ringet til revisoren.”</li></ul>
            </div>
          </details>

          <details className="help-section">
            <summary>5. Slet en opgave</summary>
            <p>Slet en forkert eller uaktuel opgave. Hvis opgaven allerede
              er klaret, bør du i stedet markere den som udført, så du kan finde den senere.
              Du skal altid bekræfte sletning.</p>
            <div className="help-examples">
              <strong>Eksempel</strong>
              <ul><li>„Slet frisørtiden på fredag.”</li></ul>
            </div>
          </details>
        </div>
      </section>
    </main>
  )
}
