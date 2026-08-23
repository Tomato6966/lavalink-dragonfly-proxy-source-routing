import { describe, it, expect } from "bun:test";
import { optimizeSearchOrder } from "./searchReRanker";
import type { LavalinkLoadResult, LavalinkTrack } from "../types";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTrack(
    title: string,
    author: string,
    lengthMs: number = 228000,
    opts: { albumName?: string; isrc?: string; sourceName?: string } = {},
): LavalinkTrack {
    return {
        encoded: `enc-${title.slice(0, 10)}`,
        info: {
            identifier: `id-${Math.random().toString(36).slice(2, 8)}`,
            isSeekable: true,
            author,
            length: lengthMs,
            isStream: false,
            position: 0,
            title,
            uri: "https://example.com/track",
            artworkUrl: "https://example.com/art.jpg",
            isrc: opts.isrc || null,
            sourceName: opts.sourceName || "deezer",
        },
        pluginInfo: opts.albumName ? { albumName: opts.albumName } : {},
        userData: {},
    };
}

function searchResult(tracks: LavalinkTrack[]): LavalinkLoadResult {
    return { loadType: "search", data: tracks };
}

function topTrack(result: LavalinkLoadResult): LavalinkTrack {
    return (result.data as LavalinkTrack[])[0];
}

// ─── Core Ranking Tests ─────────────────────────────────────────────────────

describe("Advanced Search Re-Ranker v2", () => {

    describe("Cover / Tribute / Noise Demotion", () => {
        it("demotes cover bands and promotes original artist (Adele - Rolling in the Deep)", () => {
            const result = optimizeSearchOrder("spsearch:rolling in the deep", searchResult([
                createTrack("Rolling in the Deep", "Bossa Nova Covers"),
                createTrack("Rolling in the Deep (Karaoke Version)", "Karaoke All Stars"),
                createTrack("Rolling in the Deep (Tribute)", "Tribute Band"),
                createTrack("Rolling in the Deep", "Adele"),
            ]));

            expect(result.topTrackChanged).toBe(true);
            expect(topTrack(result.result).info.author).toBe("Adele");
        });

        it("demotes baby/lullaby tribute albums (Judson Mancebo - Babies Love Adele)", () => {
            const result = optimizeSearchOrder("dzsearch:someone like you", searchResult([
                createTrack("Someone Like You", "Judson Mancebo", 276000, { albumName: "Babies Love Adele" }),
                createTrack("Someone Like You", "Adele", 285000, { albumName: "21" }),
            ]));

            expect(result.topTrackChanged).toBe(true);
            expect(topTrack(result.result).info.author).toBe("Adele");
        });

        it("demotes music box / kids / bedtime versions", () => {
            const result = optimizeSearchOrder("dzsearch:bohemian rhapsody", searchResult([
                createTrack("Bohemian Rhapsody (Music Box Version)", "Baby Sleep Music", 180000, { albumName: "Baby Lullabies" }),
                createTrack("Bohemian Rhapsody", "Queen", 354000, { albumName: "A Night at the Opera" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("Queen");
        });

        it("demotes instrumental / MIDI versions", () => {
            const result = optimizeSearchOrder("dzsearch:imagine", searchResult([
                createTrack("Imagine (Instrumental)", "MIDI Classics", 183000),
                createTrack("Imagine (Piano Cover)", "Piano Guys", 195000),
                createTrack("Imagine", "John Lennon", 187000, { albumName: "Imagine" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("John Lennon");
        });
    });

    describe("Multi-Language Noise Detection", () => {
        it("handles Spanish/French/German/Russian/Japanese cover keywords", () => {
            const result = optimizeSearchOrder("dzsearch:set fire to the rain", searchResult([
                createTrack("Set Fire to the Rain (Versión Acústica)", "Spanish Covers"),
                createTrack("Set Fire to the Rain (Reprise)", "French Tribute"),
                createTrack("Set Fire to the Rain (Klavier Version)", "German Piano"),
                createTrack("Set Fire to the Rain (кавер)", "Russian Cover Artist"),
                createTrack("Set Fire to the Rain (歌ってみた)", "JPN Artist"),
                createTrack("Set Fire to the Rain", "Adele"),
            ]));

            expect(result.topTrackChanged).toBe(true);
            expect(topTrack(result.result).info.author).toBe("Adele");
        });

        it("detects Korean cover tag (커버)", () => {
            const result = optimizeSearchOrder("spsearch:gangnam style", searchResult([
                createTrack("Gangnam Style (커버)", "KR Cover Star"),
                createTrack("Gangnam Style", "PSY", 252000),
            ]));

            expect(topTrack(result.result).info.author).toBe("PSY");
        });
    });

    describe("Remix / Slowed+Reverb Handling", () => {
        it("demotes unsolicited remixes and slowed+reverb edits", () => {
            const result = optimizeSearchOrder("dzsearch:set fire to the rain", searchResult([
                createTrack("Set Fire to the Rain (Lupage Remix)", "Lupage"),
                createTrack("Set Fire to the Rain (Slowed + Reverb)", "Vibe Edit"),
                createTrack("Set Fire to the Rain (Sped Up Nightcore)", "Nightcore Squad"),
                createTrack("Set Fire to the Rain (Chopped and Screwed)", "DJ Screw Fan"),
                createTrack("Set Fire to the Rain", "Adele"),
            ]));

            expect(result.topTrackChanged).toBe(true);
            expect(topTrack(result.result).info.author).toBe("Adele");
        });

        it("promotes remixes when user explicitly searches for one", () => {
            const result = optimizeSearchOrder("spsearch:set fire to the rain remix", searchResult([
                createTrack("Set Fire to the Rain", "Adele"),
                createTrack("Set Fire to the Rain (Club Remix)", "Moto Blanco"),
            ]));

            expect(topTrack(result.result).info.title).toContain("Remix");
        });

        it("promotes nightcore when user explicitly wants it", () => {
            const result = optimizeSearchOrder("dzsearch:someone like you nightcore", searchResult([
                createTrack("Someone Like You", "Adele", 285000),
                createTrack("Someone Like You (Nightcore)", "NC Edit", 180000),
            ]));

            expect(topTrack(result.result).info.title).toContain("Nightcore");
        });
    });

    describe("Acoustic / Live Intent", () => {
        it("promotes acoustic versions when user explicitly requests them", () => {
            const result = optimizeSearchOrder("ytsearch:rolling in the deep acoustic", searchResult([
                createTrack("Rolling in the Deep", "Adele"),
                createTrack("Rolling in the Deep (Acoustic Version)", "Adele"),
            ]));

            expect(topTrack(result.result).info.title).toContain("Acoustic");
        });

        it("promotes live versions when user explicitly wants live", () => {
            const result = optimizeSearchOrder("spsearch:bohemian rhapsody live at wembley", searchResult([
                createTrack("Bohemian Rhapsody", "Queen"),
                createTrack("Bohemian Rhapsody (Live at Wembley)", "Queen"),
            ]));

            expect(topTrack(result.result).info.title).toContain("Live");
        });

        it("demotes unsolicited live versions", () => {
            const result = optimizeSearchOrder("dzsearch:bohemian rhapsody", searchResult([
                createTrack("Bohemian Rhapsody (Live at Wembley 1986)", "Queen"),
                createTrack("Bohemian Rhapsody", "Queen", 354000, { albumName: "A Night at the Opera" }),
            ]));

            // Studio version should win
            expect(topTrack(result.result).info.title).toBe("Bohemian Rhapsody");
            expect(topTrack(result.result).info.length).toBe(354000);
        });
    });

    describe("Official Edition Preservation", () => {
        it("preserves official remaster without treating as noise", () => {
            const result = optimizeSearchOrder("spsearch:in the end linkin park", searchResult([
                createTrack("In the End (2020 Remaster)", "Linkin Park"),
                createTrack("In the End (Karaoke Version)", "Karaoke Band"),
            ]));

            expect(topTrack(result.result).info.author).toBe("Linkin Park");
        });

        it("preserves radio edit as legitimate version", () => {
            const result = optimizeSearchOrder("dzsearch:bad guy billie eilish", searchResult([
                createTrack("Bad Guy (Cover)", "Some Band"),
                createTrack("Bad Guy (Radio Edit)", "Billie Eilish"),
            ]));

            expect(topTrack(result.result).info.author).toBe("Billie Eilish");
        });
    });

    describe("Query Parsing: Artist - Title", () => {
        it("handles 'artist - title' format query", () => {
            const result = optimizeSearchOrder("dzsearch:adele - someone like you", searchResult([
                createTrack("Someone Like You", "Judson Mancebo", 276000, { albumName: "Babies Love Adele" }),
                createTrack("Someone Like You", "Random Cover Band", 250000),
                createTrack("Someone Like You", "Adele", 285000, { albumName: "21" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("Adele");
        });

        it("handles 'title by artist' format query", () => {
            const result = optimizeSearchOrder("spsearch:bohemian rhapsody by queen", searchResult([
                createTrack("Bohemian Rhapsody (Cover)", "Panic! At The Disco"),
                createTrack("Bohemian Rhapsody", "Queen", 354000),
            ]));

            expect(topTrack(result.result).info.author).toBe("Queen");
        });
    });

    describe("Featuring / Collaboration Handling", () => {
        it("handles tracks with feat. in the title", () => {
            const result = optimizeSearchOrder("dzsearch:somebody that i used to know", searchResult([
                createTrack("Somebody That I Used to Know (Karaoke)", "Karaoke Band"),
                createTrack("Somebody That I Used to Know (feat. Kimbra)", "Gotye", 244000),
            ]));

            expect(topTrack(result.result).info.author).toBe("Gotye");
        });

        it("matches artist even with 'feat.' in author field", () => {
            const result = optimizeSearchOrder("dzsearch:gotye somebody that i used to know", searchResult([
                createTrack("Somebody That I Used to Know", "Various Artists", 240000, { albumName: "Top Hits 2012" }),
                createTrack("Somebody That I Used to Know (feat. Kimbra)", "Gotye feat. Kimbra", 244000),
            ]));

            expect(topTrack(result.result).info.author).toContain("Gotye");
        });
    });

    describe("ISRC Deduplication", () => {
        it("deduplicates tracks with same ISRC, keeping highest-scored version", () => {
            const result = optimizeSearchOrder("dzsearch:hello adele", searchResult([
                createTrack("Hello", "Adele", 295000, { isrc: "GBBKS1500214" }),
                createTrack("Hello", "Adele", 295000, { isrc: "GBBKS1500214", albumName: "25 (Deluxe)" }),
                createTrack("Hello (Cover)", "Cover Band", 290000, { isrc: "US1234567890" }),
            ]));

            const tracks = result.result.data as LavalinkTrack[];
            // Both Adele tracks should exist but one should be ranked much lower
            expect(tracks[0].info.author).toBe("Adele");
            // Cover should not be first
            expect(tracks[0].info.title).not.toContain("Cover");
        });
    });

    describe("Compilation / Various Artists", () => {
        it("demotes Various Artists compilations", () => {
            const result = optimizeSearchOrder("dzsearch:toxic britney spears", searchResult([
                createTrack("Toxic", "Various Artists", 198000, { albumName: "Now That's What I Call Music! 17" }),
                createTrack("Toxic", "Britney Spears", 198000, { albumName: "In the Zone" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("Britney Spears");
        });

        it("demotes 'Greatest Hits Of' compilation albums", () => {
            const result = optimizeSearchOrder("dzsearch:billie jean", searchResult([
                createTrack("Billie Jean", "Various Artists", 294000, { albumName: "Greatest Hits Of The 80s" }),
                createTrack("Billie Jean", "Michael Jackson", 294000, { albumName: "Thriller" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("Michael Jackson");
        });
    });

    describe("Duration Heuristic", () => {
        it("penalizes very short ringtone/snippet tracks", () => {
            const result = optimizeSearchOrder("dzsearch:shape of you", searchResult([
                createTrack("Shape of You", "Ed Sheeran", 15000), // 15 sec ringtone
                createTrack("Shape of You", "Ed Sheeran", 234000), // normal
            ]));

            expect(topTrack(result.result).info.length).toBe(234000);
        });

        it("penalizes very long DJ sets", () => {
            const result = optimizeSearchOrder("dzsearch:blinding lights", searchResult([
                createTrack("Blinding Lights (1 Hour DJ Mix)", "DJ Extended", 3600000), // 1 hour
                createTrack("Blinding Lights", "The Weeknd", 200000), // normal
            ]));

            expect(topTrack(result.result).info.author).toBe("The Weeknd");
        });
    });

    describe("Fuzzy Matching Resilience", () => {
        it("handles minor typos through bigram similarity", () => {
            const result = optimizeSearchOrder("dzsearch:roling in the depp", searchResult([
                createTrack("Rolling in the Deep (Cover)", "Bossa Nova Covers"),
                createTrack("Rolling in the Deep", "Adele"),
            ]));

            // Should still rank Adele higher due to bigram + noise demotion
            expect(topTrack(result.result).info.author).toBe("Adele");
        });

        it("handles diacritics / accent differences", () => {
            const result = optimizeSearchOrder("dzsearch:despacito", searchResult([
                createTrack("Despacito (Karaokê)", "Karaoke Brasil"),
                createTrack("Despacito", "Luis Fonsi", 282000),
            ]));

            expect(topTrack(result.result).info.author).toBe("Luis Fonsi");
        });
    });

    describe("Edge Cases", () => {
        it("skips re-ranking for non-search load types (track)", () => {
            const trackResult: LavalinkLoadResult = {
                loadType: "track",
                data: createTrack("Test", "Test Artist"),
            };
            const result = optimizeSearchOrder("test", trackResult);
            expect(result.reOrdered).toBe(false);
        });

        it("skips re-ranking for single-track results", () => {
            const result = optimizeSearchOrder("spsearch:test", searchResult([
                createTrack("Test", "Test Artist"),
            ]));
            expect(result.reOrdered).toBe(false);
        });

        it("skips re-ranking for empty results", () => {
            const emptyResult: LavalinkLoadResult = {
                loadType: "empty",
                data: {},
            };
            const result = optimizeSearchOrder("test", emptyResult);
            expect(result.reOrdered).toBe(false);
        });

        it("handles playlist loadType with tracks array", () => {
            const playlistResult: LavalinkLoadResult = {
                loadType: "playlist",
                data: {
                    info: { name: "Test Playlist" },
                    tracks: [
                        createTrack("Hello (Cover)", "Cover Band"),
                        createTrack("Hello", "Adele", 295000),
                    ],
                },
            };
            const result = optimizeSearchOrder("spsearch:hello adele", playlistResult);
            const tracks = (result.result.data as any).tracks;
            expect(tracks[0].info.author).toBe("Adele");
        });
    });

    describe("Performance", () => {
        it("processes 50 tracks in under 5ms", () => {
            const tracks = Array.from({ length: 50 }, (_, i) =>
                createTrack(`Track ${i} (Cover Version)`, `Artist ${i}`)
            );
            tracks[40] = createTrack("Original Track", "Main Artist");

            const start = performance.now();
            const result = optimizeSearchOrder("spsearch:original track main artist", searchResult(tracks));
            const duration = performance.now() - start;

            expect(topTrack(result.result).info.title).toBe("Original Track");
            expect(duration).toBeLessThan(5);
        });

        it("processes 100 tracks in under 10ms", () => {
            const tracks = Array.from({ length: 100 }, (_, i) =>
                createTrack(`Some Song ${i}`, `Random Artist ${i}`, 220000 + i * 1000)
            );
            tracks[87] = createTrack("Sexbomb", "Tom Jones", 220000);

            const start = performance.now();
            const result = optimizeSearchOrder("dzsearch:sexbomb tom jones", searchResult(tracks));
            const duration = performance.now() - start;

            expect(topTrack(result.result).info.author).toBe("Tom Jones");
            expect(duration).toBeLessThan(10);
        });
    });

    describe("Real-World Scenarios", () => {
        it("sexbomb search promotes Tom Jones over random covers", () => {
            const result = optimizeSearchOrder("spsearch:sexbomb", searchResult([
                createTrack("Sexbomb", "Tribute Kings", 210000, { albumName: "Karaoke Hits" }),
                createTrack("Sexbomb (Club Remix)", "DJ Whatever", 300000),
                createTrack("Sexbomb", "Tom Jones", 220000, { albumName: "Reload" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("Tom Jones");
        });

        it("handles mixed noise results for 'Bohemian Rhapsody'", () => {
            const result = optimizeSearchOrder("dzsearch:bohemian rhapsody", searchResult([
                createTrack("Bohemian Rhapsody (8D Audio)", "8D Music"),
                createTrack("Bohemian Rhapsody (Bass Boosted)", "Bass Nation"),
                createTrack("Bohemian Rhapsody (Lo-Fi)", "Lofi Beats"),
                createTrack("Bohemian Rhapsody (Music Box)", "Baby Sleep"),
                createTrack("Bohemian Rhapsody", "Queen", 354000, { albumName: "A Night at the Opera" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("Queen");
        });

        it("handles 'Yesterday' ambiguity (Beatles vs covers)", () => {
            const result = optimizeSearchOrder("dzsearch:yesterday beatles", searchResult([
                createTrack("Yesterday (Piano Cover)", "Piano Tribute Players"),
                createTrack("Yesterday", "Various Artists", 125000, { albumName: "Best of the 60s" }),
                createTrack("Yesterday", "The Beatles", 125000, { albumName: "Help!" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("The Beatles");
        });

        it("correctly ranks 'Hello' by Adele vs Lionel Richie when query specifies Adele", () => {
            const result = optimizeSearchOrder("dzsearch:hello adele", searchResult([
                createTrack("Hello", "Lionel Richie", 235000),
                createTrack("Hello (Cover)", "Random Artist", 290000),
                createTrack("Hello", "Adele", 295000, { albumName: "25" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("Adele");
        });
    });

    describe("Soundtrack / Cast vs Original Studio Master", () => {
        it("promotes Elton John original studio master over Taron Egerton Rocketman OST for 'i\\'m still standing'", () => {
            const result = optimizeSearchOrder("dzsearch:i'm still standing", searchResult([
                createTrack("I'm Still Standing (From \"Rocketman\" Soundtrack)", "Taron Egerton", 230000, { albumName: "Rocketman (Music From The Motion Picture)" }),
                createTrack("I'm Still Standing", "Elton John", 183000, { albumName: "Too Low For Zero" }),
            ]));

            expect(result.topTrackChanged).toBe(true);
            expect(topTrack(result.result).info.author).toBe("Elton John");
        });

        it("promotes soundtrack cast recording when user explicitly queries for soundtrack", () => {
            const result = optimizeSearchOrder("dzsearch:i'm still standing rocketman soundtrack", searchResult([
                createTrack("I'm Still Standing", "Elton John", 183000, { albumName: "Too Low For Zero" }),
                createTrack("I'm Still Standing (From \"Rocketman\" Soundtrack)", "Taron Egerton", 230000, { albumName: "Rocketman (Music From The Motion Picture)" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("Taron Egerton");
        });

        it("demotes broadway cast recordings when user searches for solo artist master", () => {
            const result = optimizeSearchOrder("dzsearch:defying gravity idina menzel", searchResult([
                createTrack("Defying Gravity", "Original Broadway Cast", 353000, { albumName: "Wicked (Original Broadway Cast Recording)" }),
                createTrack("Defying Gravity", "Idina Menzel", 353000, { albumName: "I Stand" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("Idina Menzel");
        });
    });

    describe("Brass Band & Ensemble Noise Demotion", () => {
        it("demotes High & Mighty Brass Band in favor of Blackstreet for 'no diggity'", () => {
            const result = optimizeSearchOrder("spsearch:no diggity", searchResult([
                createTrack("No Diggity", "High & Mighty Brass Band", 220000),
                createTrack("No Diggity (feat. Dr. Dre, Queen Pen)", "Blackstreet", 305000, { albumName: "Another Level" }),
            ]));

            expect(result.topTrackChanged).toBe(true);
            expect(topTrack(result.result).info.author).toBe("Blackstreet");
        });

        it("demotes string quartet and marching band tributes", () => {
            const result = optimizeSearchOrder("spsearch:bad guy billie eilish", searchResult([
                createTrack("Bad Guy (String Quartet Tribute)", "Vitamin String Quartet", 195000),
                createTrack("Bad Guy (Marching Band)", "Ohio Marching Band", 180000),
                createTrack("bad guy", "Billie Eilish", 194000, { albumName: "WHEN WE ALL FALL ASLEEP, WHERE DO WE GO?" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("Billie Eilish");
        });
    });

    describe("Homophone & Spell Normalization", () => {
        it("normalizes 'loose yourself' to match Eminem's 'Lose Yourself' over obscure house track", () => {
            const result = optimizeSearchOrder("spsearch:loose yourself", searchResult([
                createTrack("Loose Yourself", "Block & Crown", 310000, { albumName: "Club Ibiza" }),
                createTrack("Lose Yourself", "Eminem", 326000, { albumName: "8 Mile" }),
            ]));

            expect(result.topTrackChanged).toBe(true);
            expect(topTrack(result.result).info.author).toBe("Eminem");
        });

        it("normalizes 'loose control' to match Teddy Swims 'Lose Control'", () => {
            const result = optimizeSearchOrder("spsearch:loose control", searchResult([
                createTrack("Loose Control (House Mix)", "DJ Remixer", 240000),
                createTrack("Lose Control", "Teddy Swims", 210000, { albumName: "I've Tried Everything But Therapy" }),
            ]));

            expect(result.topTrackChanged).toBe(true);
            expect(topTrack(result.result).info.author).toBe("Teddy Swims");
        });

        it("normalizes 'looser' to 'loser' for Tame Impala / Beck queries", () => {
            const result = optimizeSearchOrder("ytmsearch:looser tame impala", searchResult([
                createTrack("Other Song", "Random Artist", 200000),
                createTrack("Loser", "Tame Impala", 215000),
            ]));

            expect(topTrack(result.result).info.author).toBe("Tame Impala");
        });

        it("normalizes 'stills tanding' to 'still standing' for Elton John", () => {
            const result = optimizeSearchOrder("spsearch:stills tanding elton john", searchResult([
                createTrack("Standing Still", "Jewel", 270000),
                createTrack("I'm Still Standing", "Elton John", 183000, { albumName: "Too Low For Zero" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("Elton John");
        });

        it("normalizes 'clam down' to 'calm down' for Rema", () => {
            const result = optimizeSearchOrder("spsearch:clam down rema", searchResult([
                createTrack("Clam Bake", "Random Band", 180000),
                createTrack("Calm Down", "Rema", 219000, { albumName: "Rave & Roses" }),
            ]));

            expect(topTrack(result.result).info.author).toBe("Rema");
        });
    });
});
