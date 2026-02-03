/**
 * Seed data for states, districts, mandals.
 * Mirrors frontend lib/indian-states-data (excluding Andhra Pradesh districts/mandals;
 * AP state is created; add AP districts/mandals via UI or separate script).
 */
export const STATE_NAMES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
];

/** state name -> array of { district, mandals: string[] }. Andhra Pradesh omitted (add via UI or seed script). */
export const STATE_DISTRICTS_MANDALS = {
  Telangana: [
    { district: 'Hyderabad', mandals: ['Ameerpet', 'Asifnagar', 'Bahadurpura', 'Bandlaguda', 'Charminar', 'Golconda', 'Himayathnagar', 'Khairatabad', 'Malakpet', 'Musheerabad', 'Nampally', 'Secunderabad', 'Shaikpet', 'Tirumalagiri'] },
    { district: 'Rangareddy', mandals: ['Abdullapurmet', 'Bachpalle', 'Balapur', 'Chevella', 'Doma', 'Ghatkesar', 'Hayathnagar', 'Ibrahimpatnam', 'Kandukur', 'Keesara', 'Malkajgiri', 'Medchal', 'Qutubullapur', 'Rajendranagar', 'Saroornagar', 'Serilingampally', 'Shamirpet', 'Shankarpalle', 'Uppal'] },
    { district: 'Medak', mandals: ['Alladurg', 'Andole', 'Chegunta', 'Dubbak', 'Gajwel', 'Jogipet', 'Kohir', 'Kondapak', 'Medak', 'Narsapur', 'Narsingi', 'Nizampet', 'Papannapet', 'Patancheru', 'Ramayampet', 'Sadasivpet', 'Sangareddy', 'Shankarampet', 'Siddipet', 'Tekmal', 'Toopran', 'Yeldurthy', 'Zahirabad'] },
    { district: 'Nizamabad', mandals: ['Armoor', 'Balkonda', 'Banswada', 'Bheemgal', 'Bichkunda', 'Birkur', 'Bodhan', 'Dichpalle', 'Dharpalle', 'Domakonda', 'Jakranpalle', 'Jukkal', 'Kamareddy', 'Kammarpalle', 'Kotgiri', 'Lingampet', 'Machareddy', 'Madnur', 'Mendora', 'Nagareddypet', 'Nandipet', 'Nizamabad', 'Pitlam', 'Renjal', 'Sadasivnagar', 'Sirikonda', 'Varni', 'Velpur', 'Yellareddy'] },
    { district: 'Karimnagar', mandals: ['Beerpur', 'Bheemaram', 'Boinpalle', 'Chigurumamidi', 'Choppadandi', 'Dharmapuri', 'Ellanthakunta', 'Gangadhara', 'Gollapalle', 'Husnabad', 'Jagtial', 'Jammikunta', 'Kamanpur', 'Karimnagar', 'Kataram', 'Korutla', 'Mallapur', 'Manakondur', 'Manthani', 'Medipalle', 'Mustabad', 'Peddapalle', 'Pegadapalle', 'Ramadugu', 'Saidapur', 'Sircilla', 'Sultanabad', 'Thimmapur', 'Veenavanka', 'Vemulawada'] },
    { district: 'Warangal', mandals: ['Atmakur', 'Bachannapet', 'Bhupalpalle', 'Chityal', 'Dornakal', 'Eturnagaram', 'Ghanpur', 'Ghanpur Station', 'Gudur', 'Hanamkonda', 'Hasanparthy', 'Jangaon', 'Kazipet', 'Khanapur', 'Kodakandla', 'Kothagudem', 'Mahabubabad', 'Mallampalle', 'Mogullapalle', 'Mulug', 'Nallabelly', 'Narmetta', 'Narsampet', 'Nekkonda', 'Palakurthy', 'Parkal', 'Raghunathpalle', 'Regonda', 'Sangam', 'Shayampet', 'Thorrur', 'Wardhannapet', 'Warangal'] },
  ],
  Karnataka: [
    { district: 'Bangalore Urban', mandals: ['Anekal', 'Bangalore North', 'Bangalore South', 'Bangalore East', 'Bangalore West', 'Yelahanka'] },
    { district: 'Mysore', mandals: ['Heggadadevankote', 'Hunsur', 'Krishnarajanagara', 'Mysore', 'Nanjangud', 'Piriyapatna', 'Tirumakudalu Narasipura'] },
    { district: 'Mangalore', mandals: ['Bantwal', 'Belthangady', 'Kadaba', 'Mangalore', 'Moodbidri', 'Puttur', 'Sullia'] },
  ],
  'Tamil Nadu': [
    { district: 'Chennai', mandals: ['Ambattur', 'Alandur', 'Egmore', 'Guindy', 'Madhavaram', 'Mylapore', 'Perambur', 'Tondiarpet', 'Velachery'] },
    { district: 'Coimbatore', mandals: ['Coimbatore North', 'Coimbatore South', 'Mettupalayam', 'Pollachi', 'Sulur', 'Thondamuthur'] },
    { district: 'Madurai', mandals: ['Madurai North', 'Madurai South', 'Melur', 'Peraiyur', 'Thirumangalam', 'Usilampatti'] },
  ],
  Kerala: [
    { district: 'Thiruvananthapuram', mandals: ['Chirayinkeezhu', 'Neyyattinkara', 'Thiruvananthapuram', 'Varkala'] },
    { district: 'Kochi', mandals: ['Aluva', 'Ernakulam', 'Kochi', 'Kanayannur', 'Kothamangalam', 'Muvattupuzha', 'Paravur'] },
    { district: 'Kozhikode', mandals: ['Kozhikode', 'Koyilandy', 'Thamarassery', 'Vadakara'] },
  ],
  Maharashtra: [
    { district: 'Mumbai', mandals: ['Andheri', 'Bandra', 'Borivali', 'Chembur', 'Colaba', 'Dadar', 'Goregaon', 'Kurla', 'Malad', 'Mulund', 'Powai', 'Santacruz', 'Thane', 'Vashi'] },
    { district: 'Pune', mandals: ['Baramati', 'Bhor', 'Daund', 'Haveli', 'Indapur', 'Junnar', 'Khed', 'Maval', 'Mulshi', 'Pune', 'Purandar', 'Shirur', 'Velhe'] },
    { district: 'Nagpur', mandals: ['Hingna', 'Kalmeshwar', 'Kamptee', 'Katol', 'Kuhi', 'Mauda', 'Nagpur', 'Narkhed', 'Parseoni', 'Ramtek', 'Savner', 'Umred'] },
  ],
  Gujarat: [
    { district: 'Ahmedabad', mandals: ['Ahmedabad City', 'Bavla', 'Daskroi', 'Dholka', 'Dhandhuka', 'Mandal', 'Sanand', 'Viramgam'] },
    { district: 'Surat', mandals: ['Bardoli', 'Choryasi', 'Kamrej', 'Mahuva', 'Mandvi', 'Olpad', 'Palsana', 'Surat City', 'Umarpada'] },
    { district: 'Vadodara', mandals: ['Dabhoi', 'Karjan', 'Padra', 'Savli', 'Sinor', 'Vadodara', 'Waghodia'] },
  ],
  Rajasthan: [
    { district: 'Jaipur', mandals: ['Amber', 'Bassi', 'Chaksu', 'Chomu', 'Jaipur', 'Phagi', 'Phulera', 'Sanganer', 'Shahpura', 'Viratnagar'] },
    { district: 'Jodhpur', mandals: ['Balesar', 'Bap', 'Bhopalgarh', 'Jodhpur', 'Luni', 'Osian', 'Phalodi', 'Shergarh', 'Tivri'] },
    { district: 'Udaipur', mandals: ['Girwa', 'Gogunda', 'Jhadol', 'Kherwara', 'Kotra', 'Mavli', 'Rishabhdeo', 'Salumbar', 'Sarada', 'Udaipur'] },
  ],
  'Uttar Pradesh': [
    { district: 'Lucknow', mandals: ['Bakshi Ka Talab', 'Gosainganj', 'Lucknow', 'Malihabad', 'Mohanlalganj', 'Sarojini Nagar'] },
    { district: 'Kanpur', mandals: ['Bilhaur', 'Ghatampur', 'Kanpur', 'Sarsaul', 'Sisamau'] },
    { district: 'Agra', mandals: ['Agra', 'Fatehabad', 'Fatehpur Sikri', 'Kheragarh', 'Kiraoli'] },
  ],
  Delhi: [
    { district: 'Central Delhi', mandals: ['Daryaganj', 'Karol Bagh', 'Paharganj', 'Sadar Bazar'] },
    { district: 'North Delhi', mandals: ['Civil Lines', 'Model Town', 'Narela', 'Rohini', 'Shahdara'] },
    { district: 'South Delhi', mandals: ['Defence Colony', 'Hauz Khas', 'Mehrauli', 'Saket', 'Vasant Kunj'] },
  ],
  'West Bengal': [
    { district: 'Kolkata', mandals: ['Alipore', 'Behala', 'Bhowanipore', 'Jadavpur', 'Kolkata Port', 'Tollygunge'] },
    { district: 'Howrah', mandals: ['Bally', 'Domjur', 'Howrah', 'Jagatballavpur', 'Panchla', 'Sankrail', 'Uluberia'] },
    { district: 'North 24 Parganas', mandals: ['Barasat', 'Barrackpore', 'Bidhannagar', 'Dum Dum', 'Habra', 'Kanchrapara'] },
  ],
  Punjab: [
    { district: 'Amritsar', mandals: ['Amritsar', 'Ajnala', 'Attari', 'Baba Bakala', 'Majitha', 'Tarn Taran'] },
    { district: 'Ludhiana', mandals: ['Dehlon', 'Jagraon', 'Khanna', 'Ludhiana', 'Payal', 'Raikot', 'Samrala'] },
    { district: 'Chandigarh', mandals: ['Chandigarh'] },
  ],
  Haryana: [
    { district: 'Gurgaon', mandals: ['Badshahpur', 'Farrukhnagar', 'Gurgaon', 'Pataudi', 'Sohna', 'Wazirabad'] },
    { district: 'Faridabad', mandals: ['Ballabgarh', 'Faridabad', 'Hathin', 'Palwal', 'Tigaon'] },
    { district: 'Panipat', mandals: ['Israna', 'Panipat', 'Samalkha'] },
  ],
  Bihar: [
    { district: 'Patna', mandals: ['Barh', 'Bikram', 'Danapur', 'Fatuha', 'Maner', 'Masaurhi', 'Patna', 'Phulwari'] },
    { district: 'Gaya', mandals: ['Atri', 'Bodh Gaya', 'Gaya', 'Imamganj', 'Mohanpur', 'Nawada', 'Sherghati', 'Tikari'] },
    { district: 'Muzaffarpur', mandals: ['Bochaha', 'Kanti', 'Kurhani', 'Muzaffarpur', 'Paroo', 'Sakra', 'Saraiya'] },
  ],
  Odisha: [
    { district: 'Bhubaneswar', mandals: ['Balianta', 'Bhubaneswar', 'Jatni', 'Khordha', 'Lingaraj', 'Nimapara'] },
    { district: 'Cuttack', mandals: ['Athagarh', 'Banki', 'Baranga', 'Cuttack', 'Kantapada', 'Niali', 'Salepur', 'Tangi'] },
    { district: 'Puri', mandals: ['Brahmagiri', 'Delang', 'Gop', 'Kakatpur', 'Pipili', 'Puri', 'Satyabadi'] },
  ],
  Assam: [
    { district: 'Guwahati', mandals: ['Azara', 'Chandrapur', 'Dispur', 'Guwahati', 'North Guwahati', 'Sonapur'] },
    { district: 'Dibrugarh', mandals: ['Chabua', 'Dibrugarh', 'Lahowal', 'Naharkatiya', 'Tengakhat'] },
    { district: 'Silchar', mandals: ['Katigorah', 'Lakhipur', 'Silchar', 'Sonai', 'Udharbond'] },
  ],
  Jharkhand: [
    { district: 'Ranchi', mandals: ['Angara', 'Bero', 'Bundu', 'Kanke', 'Lapung', 'Mandar', 'Namkum', 'Ormanjhi', 'Ratu', 'Ranchi', 'Silli', 'Tamar'] },
    { district: 'Jamshedpur', mandals: ['Baharagora', 'Chakulia', 'Dhalbhumgarh', 'Ghatshila', 'Jamshedpur', 'Potka'] },
    { district: 'Dhanbad', mandals: ['Baghmara', 'Baliapur', 'Dhanbad', 'Govindpur', 'Jharia', 'Nirsa', 'Tundi'] },
  ],
  Chhattisgarh: [
    { district: 'Raipur', mandals: ['Abhanpur', 'Arang', 'Bhatapara', 'Bilaigarh', 'Dharsiwa', 'Gariaband', 'Raipur', 'Tilda'] },
    { district: 'Bilaspur', mandals: ['Bilaspur', 'Kota', 'Lormi', 'Masturi', 'Pendra', 'Takhatpur'] },
    { district: 'Durg', mandals: ['Balod', 'Dhamdha', 'Durg', 'Gunderdehi', 'Patan', 'Saja'] },
  ],
  'Madhya Pradesh': [
    { district: 'Bhopal', mandals: ['Berasia', 'Bhopal', 'Huzur', 'Phanda', 'Vidisha'] },
    { district: 'Indore', mandals: ['Depalpur', 'Hatod', 'Indore', 'Mhow', 'Sanwer'] },
    { district: 'Gwalior', mandals: ['Bhitarwar', 'Dabra', 'Gwalior', 'Morar', 'Pichhore'] },
  ],
  'Himachal Pradesh': [
    { district: 'Shimla', mandals: ['Chopal', 'Jubbal', 'Kotkhai', 'Kumarsain', 'Rohru', 'Shimla', 'Theog'] },
    { district: 'Kullu', mandals: ['Anni', 'Banjar', 'Kullu', 'Manali', 'Nirmand'] },
    { district: 'Dharamshala', mandals: ['Baijnath', 'Dharamshala', 'Kangra', 'Palampur'] },
  ],
  Uttarakhand: [
    { district: 'Dehradun', mandals: ['Chakrata', 'Dehradun', 'Doiwala', 'Rishikesh', 'Vikasnagar'] },
    { district: 'Haridwar', mandals: ['Bhagwanpur', 'Haridwar', 'Laksar', 'Roorkee'] },
    { district: 'Nainital', mandals: ['Haldwani', 'Kaladhungi', 'Nainital', 'Ramnagar'] },
  ],
  Goa: [
    { district: 'North Goa', mandals: ['Bardez', 'Bicholim', 'Pernem', 'Sattari', 'Tiswadi'] },
    { district: 'South Goa', mandals: ['Canacona', 'Mormugao', 'Quepem', 'Salcete', 'Sanguem'] },
  ],
  Puducherry: [
    { district: 'Puducherry', mandals: ['Bahour', 'Ozhukarai', 'Puducherry', 'Villupuram'] },
  ],
  Manipur: [
    { district: 'Imphal', mandals: ['Bishnupur', 'Imphal East', 'Imphal West', 'Thoubal'] },
  ],
  Meghalaya: [
    { district: 'Shillong', mandals: ['East Khasi Hills', 'Ri Bhoi', 'West Khasi Hills'] },
  ],
  Mizoram: [
    { district: 'Aizawl', mandals: ['Aizawl', 'Champhai', 'Kolasib', 'Lunglei'] },
  ],
  Nagaland: [
    { district: 'Kohima', mandals: ['Dimapur', 'Kohima', 'Mokokchung', 'Wokha'] },
  ],
  Tripura: [
    { district: 'Agartala', mandals: ['Dhalai', 'Gomati', 'Khowai', 'North Tripura', 'Sepahijala', 'South Tripura', 'Unakoti', 'West Tripura'] },
  ],
  'Arunachal Pradesh': [
    { district: 'Itanagar', mandals: ['East Siang', 'Lower Subansiri', 'Papum Pare', 'West Siang'] },
  ],
  Sikkim: [
    { district: 'Gangtok', mandals: ['East Sikkim', 'North Sikkim', 'South Sikkim', 'West Sikkim'] },
  ],
  'Jammu and Kashmir': [
    { district: 'Srinagar', mandals: ['Badgam', 'Ganderbal', 'Pulwama', 'Shopian', 'Srinagar'] },
    { district: 'Jammu', mandals: ['Jammu', 'Kathua', 'Rajouri', 'Reasi', 'Udhampur'] },
  ],
  Ladakh: [
    { district: 'Leh', mandals: ['Kargil', 'Leh'] },
  ],
};
