type Props = { onBack: () => void }

// Kort, dansk hjælp til de funktioner, der findes i MVP'en.
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
          <p className="lead">Skriv eller indtal, hvad du vil huske eller ændre.</p>
        </header>

        <div className="help-sections">
          <details className="help-section" open>
            <summary>Kom godt i gang</summary>
            <p>
              Fortæl med almindelige ord, hvad der skal gøres, hvornår det skal ske,
              og hvem der er ansvarlig.
            </p>
            <p><strong>Eksempel:</strong> „Jeg skal ringe til revisoren i morgen kl. 10.”</p>
            <p>Kontrollér oplysningerne, før du gemmer eller ændrer noget.</p>
          </details>

          <details className="help-section" open>
            <summary>De 5 grundfunktioner</summary>
            <ol>
              <li><strong>Opret:</strong> Tilføj en opgave, aftale eller frist.</li>
              <li><strong>Søg:</strong> „Hvilke åbne opgaver har jeg?”</li>
              <li><strong>Rediger:</strong> Ændr dato, tidspunkt, påmindelse eller tilføj en note.</li>
              <li><strong>Markér som udført:</strong> „Jeg har ringet til revisoren.”</li>
              <li><strong>Slet:</strong> „Slet frisørtiden på fredag.”</li>
            </ol>
            <p>Hvis opgaven ikke er entydig, beder appen dig vælge. Ændring, afslutning og sletning skal bekræftes.</p>
          </details>

          <details className="help-section" open>
            <summary>Noter</summary>
            <p>
              Du kan tilføje en note, når du opretter en opgave:
              „Fest på lørdag, note: medbring kage og sodavand.”
            </p>
            <p>
              Til en eksisterende opgave: Søg efter opgaven, vælg
              <strong> „Tilføj note”</strong>, skriv eller indtal teksten, og bekræft.
            </p>
            <p>Tidligere noter bevares og vises sammen med opgaven i søgeresultaterne.</p>
          </details>

          <details className="help-section">
            <summary>Påmindelser, morgenoverblik og kalender</summary>
            <p>
              Du kan tilføje en påmindelse ved oprettelse eller senere:
              „Mind mig om det en time før.”
            </p>
            <p>
              Slå morgenoverblikket til, og vælg tidspunkt under Indstillinger.
              Aktivér notifikationer særskilt på hver enhed under Konto og notifikationer.
            </p>
            <p>
              Forbind Google Kalender under Indstillinger. Opgaver med dato kan sendes manuelt fra søgeresultaterne.
              Uden klokkeslæt bliver de heldagsaftaler, ellers varer de 1 time. En tidligere sendt
              opgave kan kun sendes igen efter bekræftelse, og kun hvis den ikke
              længere findes i Google Kalender. Automatisk overførsel kan aktiveres
              under Indstillinger og gælder kun nye opgaver tildelt dig med dato.
              Nye begivenheder i Google Kalender kan også overvåges efter særskilt
              aktivering. Du får højst én push-besked pr. begivenhed, og Pénzfa
              opretter først en opgave, når du godkender den. Uden svar nævnes
              forslaget højst én gang i næste morgenoverblik og udløber derefter.
            </p>
          </details>

          <details className="help-section">
            <summary>Familiemedlemmer og installation</summary>
            <p>
              Under Familiemedlemmer kan du oprette personer uden egen konto og
              invitere en anden familiebruger. En familie kan have op til to brugere med login.
            </p>
            <p>Brug Installer på telefonen til at føje appen til startskærmen.</p>
          </details>
        </div>
      </section>
    </main>
  )
}
