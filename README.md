# Studio Arsitektur

Aplikasi Node.js untuk portofolio arsitektur, impor model GLB, pembuatan pratinjau dan denah potongan, login admin, serta tautan baca-saja untuk klien.

## Persyaratan

- Node.js 20 atau lebih baru
- npm
- Browser modern dengan WebGL untuk memutar model 3D

## Menjalankan aplikasi

```powershell
npm install
npm run setup
npm start
```

`npm run setup` membuat `.env` dengan kata sandi admin acak dan rahasia sesi. **Simpan nama pengguna dan kata sandi yang ditampilkan saat setup. Kata sandi tidak disimpan dalam teks biasa dan tidak dapat ditampilkan kembali.** Buka `http://localhost:3000`, lalu pilih **Masuk Admin**.

Untuk membuat kredensial baru, cadangkan data proyek terlebih dahulu, pindahkan atau hapus `.env`, lalu jalankan `npm run setup` lagi. Jangan membagikan atau mengirim `.env`.

Mode pengembangan menggunakan:

```powershell
npm run dev
```

## Impor GLB

1. Masuk ke dashboard admin.
2. Pilih file `.glb` hasil ekspor SketchUp dan lengkapi nama, lokasi, serta tahun. Manifest lantai dari ekstensi dapat ditambahkan secara opsional; jika dipilih, jumlah lantai dan arah utara akan diisi dari manifest.
3. Sistem memeriksa struktur GLB, menghitung batas geometri dalam satuan meter, lalu membuat pratinjau SVG dan denah potongan pada elevasi setiap lantai. Tanpa manifest, elevasi lantai masih diperkirakan otomatis.
4. Periksa ukuran dan denah, ubah jumlah/nama lantai atau arah utara bila perlu, lalu pilih apakah proyek ditampilkan di daftar publik.
5. Buat tautan klien baca-saja. Masa berlaku dapat diatur 1–365 hari; tautan default berlaku 30 hari.

GLB asli disimpan tanpa perubahan. Untuk pengiriman, server membuat salinan gzip yang dapat dipulihkan byte demi byte. Jika gzip tidak mengecilkan file, server memakai file asli. Kompresi ini tidak mengoptimalkan ulang mesh atau tekstur, sehingga geometri tidak mengalami perubahan lossy.

Denah yang dibuat adalah **potongan horizontal dari geometri GLB**. Jika model tidak memiliki geometri dinding pada ketinggian potong, sistem menampilkan batas model sebagai fallback. Periksa denah sebelum diterbitkan.

### Ekstensi SketchUp 2024

File pemasangan ekstensi tersedia di `sketchup-extension/StudioArchitectureFloors.rbz`. Pasang melalui **Window > Extension Manager > Install Extension**.

1. Di konteks model utama, pilih geometri untuk satu lantai, lalu pilih **Extensions > Studio Arsitektur > Kelompokkan geometri lantai**. Beri nama dan tinggi bidang denah dari dasar lantai (default 1,1 m).
2. Ulangi untuk setiap lantai. Kolom, tangga, atau dinding yang melintasi beberapa lantai sebaiknya tetap berada di grup terpisah, bukan disalin ke grup lantai.
3. Atur arah utara melalui menu ekstensi. Ekspor model `.glb` dengan GLTF exporter SketchUp seperti biasa.
4. Pilih **Ekspor manifest denah lantai**, lalu unggah file JSON tersebut bersama GLB pada dashboard admin.

Ekstensi mengelompokkan geometri yang dipilih dan mengekspor nama grup, elevasi dasar, elevasi potongan denah, proporsi elevasi terhadap tinggi model, serta arah utara. Proporsi membantu menyesuaikan elevasi bila exporter menggeser titik asal atau skala model. Ekstensi ini **tidak mengekspor GLB**; gunakan GLTF exporter SketchUp untuk itu. Manifest tidak memuat geometri. Bila grup/elevasi salah, koreksi di SketchUp atau ubah data proyek di dashboard sebelum membagikan.

Pratinjau SVG menggunakan geometri serta warna material dasar GLB dan membatasi jumlah faset untuk menjaga ukuran gambar. Halaman klien juga menyediakan penampil 3D interaktif dari GLB.

## Bantuan AI (opsional)

AI tidak aktif sampai endpoint kompatibel OpenAI dikonfigurasi di `.env`:

```env
AI_BASE_URL=https://provider-anda.example/v1
AI_API_KEY=isi_dengan_secret_provider
AI_MODEL=nama_model
```

AI hanya dipanggil saat admin memilih **Minta saran AI** dan mencentang izin. Yang dikirim hanya ukuran, jumlah lantai, nama komponen, serta nama dan elevasi grup lantai—**file GLB mentah tidak dikirim**. AI memberi saran nama/deskripsi/label lantai; admin harus memeriksa dan menyimpan hasilnya secara terpisah. AI tidak membaca bentuk geometri untuk menggambar denah; denah dihitung lokal dari irisan GLB, sementara elevasi dari manifest mengarahkan lokasi irisannya.

Jika penyedia membalas HTTP `429`, periksa kuota/kredit API, billing, dan batas permintaan pada akun penyedia. Langganan ChatGPT tidak otomatis mencakup kredit API OpenAI.

Jika penyedia membalas HTTP `503`, layanannya mungkin sedang sibuk atau model sementara tidak tersedia. Tunggu lalu coba lagi; jika berulang, cek status model atau ganti model yang tersedia di akun penyedia.

## Kompas

Sudut utara diatur dalam derajat pada dashboard admin:

- `0°`: utara berada di atas denah.
- Sudut bertambah searah jarum jam.

Pengaturan ini mengorientasikan penanda kompas, bukan memutar geometri model. Jika model SketchUp telah memiliki orientasi utara geografis, masukkan sudut relatifnya agar simbol kompas sesuai.

## Penyimpanan dan konfigurasi

Salin `.env.example` hanya sebagai referensi; `npm run setup` membuat `.env` lokal yang benar. Pengaturan utama:

| Variabel | Fungsi |
| --- | --- |
| `PORT` | Port HTTP, default `3000` |
| `ADMIN_USERNAME` | Nama pengguna admin |
| `ADMIN_PASSWORD_HASH` | Hash scrypt kata sandi admin |
| `ADMIN_SESSION_SECRET` | Rahasia untuk menandatangani sesi |
| `MAX_GLB_MB` | Batas ukuran unggahan, default `200` MB |
| `PUBLIC_BASE_URL` | Alamat publik yang dipakai dalam tautan berbagi |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | Integrasi AI opsional |

Data proyek dan file model berada di `.private-data/`, yang tidak disajikan sebagai file publik dan dikecualikan dari Git. Buat cadangan direktori ini secara aman. Penyimpanan JSON dan sesi dalam memori ditujukan untuk satu server Node.js; deployment multi-server sebaiknya menggunakan database dan penyimpanan objek terkelola.

Untuk deployment produksi, gunakan HTTPS, atur `NODE_ENV=production`, rahasia melalui pengelola secrets hosting, batasi akses dashboard, dan pastikan `PUBLIC_BASE_URL` menunjuk ke domain HTTPS.

## Berbagi dengan klien

- Proyek privat tidak muncul dalam daftar publik.
- Tautan berbagi memakai token acak yang tidak disimpan dalam bentuk asli dan tidak dapat diedit klien.
- Klien dapat melihat model 3D, pratinjau, ukuran, kompas, dan denah lantai.
- Admin dapat mencabut seluruh tautan berbagi untuk proyek dengan menghapus tautan dari panel. Tautan kedaluwarsa otomatis.

## Pengujian

```powershell
npm test
```

Tes mencakup pembacaan GLB, pengukuran transformasi node, elevasi denah dari manifest SketchUp, pemulihan file gzip byte demi byte, login admin, impor, publikasi, dan alur tautan klien.
